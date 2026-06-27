import { feature } from 'bun:bundle'
import * as React from 'react'
import { z } from 'zod/v4'
import { getAllowedChannels } from '../../bootstrap/state.js'
import { Box, Text } from '../../ink.js'
import type { Tool } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { REVIEW_ARTIFACT_TOOL_NAME } from './constants.js'

const artifactObjectSchema = lazySchema(() =>
  z
    .object({
      key: z
        .string()
        .optional()
        .describe('Stable identifier for this artifact option'),
      label: z
        .string()
        .optional()
        .describe('Short label shown to the user'),
      description: z
        .string()
        .optional()
        .describe('Optional explanation of what the artifact contains'),
      url: z.string().optional().describe('Artifact URL'),
    })
    .passthrough(),
)

const inputSchema = lazySchema(() =>
  z
    .object({
      title: z
        .string()
        .optional()
        .describe('Optional title for the artifact selection dialog'),
      prompt: z
        .string()
        .optional()
        .describe('Question shown when asking the user which artifact to inspect'),
      artifacts: z
        .array(z.union([z.string(), artifactObjectSchema()]))
        .optional()
        .describe(
          'Artifact options. Prefer rich objects with labels and descriptions when available.',
        ),
      artifact_urls: z
        .array(z.string())
        .optional()
        .describe(
          'Artifact URLs to offer when only raw URLs are available.',
        ),
      selected: z
        .string()
        .optional()
        .describe('The key of the artifact selected by the user'),
    })
    .passthrough(),
)
type InputSchema = ReturnType<typeof inputSchema>
export type ReviewArtifactInput = z.infer<InputSchema>

const normalizedArtifactSchema = lazySchema(() =>
  z.object({
    key: z.string(),
    label: z.string(),
    description: z.string().optional(),
    url: z.string().optional(),
  }),
)

const outputSchema = lazySchema(() =>
  z.object({
    selected: z
      .string()
      .nullable()
      .describe('The key of the selected artifact, or null when none was selected'),
    artifact: normalizedArtifactSchema()
      .nullable()
      .describe('The selected artifact, or null when none was selected'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
type Output = z.infer<OutputSchema>

export type ReviewArtifactOption = z.infer<
  ReturnType<typeof normalizedArtifactSchema>
>

function firstNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function labelFromUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const filename = parsed.pathname.split('/').filter(Boolean).pop()
    return filename || parsed.hostname
  } catch {
    return url
  }
}

function optionFromArtifact(artifact: unknown): ReviewArtifactOption | null {
  if (typeof artifact === 'string' && artifact.trim() !== '') {
    return {
      key: artifact,
      label: labelFromUrl(artifact),
      url: artifact,
    }
  }

  if (!artifact || typeof artifact !== 'object') {
    return null
  }

  const record = artifact as Record<string, unknown>
  const url = firstNonEmptyString(record.url)
  const key =
    firstNonEmptyString(record.key) ??
    url ??
    firstNonEmptyString(record.label)
  const label =
    firstNonEmptyString(record.label) ??
    (url ? labelFromUrl(url) : undefined) ??
    key

  if (!key || !label) {
    return null
  }

  return {
    key,
    label,
    description: firstNonEmptyString(record.description),
    url,
  }
}

export function normalizeReviewArtifacts(
  input: Partial<ReviewArtifactInput> | Record<string, unknown>,
): ReviewArtifactOption[] {
  const results: ReviewArtifactOption[] = []

  if (Array.isArray(input.artifacts)) {
    for (const artifact of input.artifacts) {
      const option = optionFromArtifact(artifact)
      if (option) {
        results.push(option)
      }
    }
  }

  if (Array.isArray(input.artifact_urls)) {
    for (const url of input.artifact_urls) {
      const option = optionFromArtifact(url)
      if (option) {
        results.push(option)
      }
    }
  }

  const seen = new Set<string>()
  return results.filter(option => {
    if (seen.has(option.key)) {
      return false
    }
    seen.add(option.key)
    return true
  })
}

function ReviewArtifactResultMessage({
  artifact,
}: {
  artifact: ReviewArtifactOption | null
}): React.ReactNode {
  return (
    <Box flexDirection="row" marginTop={1}>
      <Text>
        {artifact
          ? `User selected review artifact: ${artifact.label}`
          : 'Review artifact approval completed without a selection'}
      </Text>
    </Box>
  )
}

export const ReviewArtifactTool: Tool<InputSchema, Output> = buildTool({
  name: REVIEW_ARTIFACT_TOOL_NAME,
  searchHint: 'ask the user which artifact Claude should inspect',
  maxResultSizeChars: 10_000,
  shouldDefer: true,
  async description() {
    return 'Ask the user to choose which review artifact Claude should inspect.'
  },
  async prompt() {
    return `Use this tool when multiple review artifacts are available and the user needs to choose one.

Provide either:
- \`artifacts\`: objects with \`key\`, \`label\`, optional \`description\`, and optional \`url\`
- or \`artifact_urls\`: raw artifact URLs when richer metadata is unavailable

The permission UI injects \`selected\` with the chosen artifact key.`
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return ''
  },
  isEnabled() {
    if (
      (feature('KAIROS') || feature('KAIROS_CHANNELS')) &&
      getAllowedChannels().length > 0
    ) {
      return false
    }
    return true
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.prompt ?? ''
  },
  requiresUserInteraction() {
    return true
  },
  async validateInput(input) {
    if (normalizeReviewArtifacts(input).length === 0) {
      return {
        result: false,
        message:
          'Provide at least one artifact via artifacts or artifact_urls.',
        errorCode: 1,
      }
    }
    return { result: true }
  },
  async checkPermissions(input) {
    return {
      behavior: 'ask' as const,
      message: 'Choose a review artifact?',
      updatedInput: input,
    }
  },
  renderToolUseMessage() {
    return null
  },
  renderToolUseProgressMessage() {
    return null
  },
  renderToolResultMessage({ artifact }) {
    return <ReviewArtifactResultMessage artifact={artifact} />
  },
  renderToolUseRejectedMessage() {
    return (
      <Box flexDirection="row" marginTop={1}>
        <Text>User declined to choose a review artifact</Text>
      </Box>
    )
  },
  renderToolUseErrorMessage() {
    return null
  },
  async call(input) {
    const selected =
      typeof input.selected === 'string' && input.selected.trim() !== ''
        ? input.selected
        : null
    const artifacts = normalizeReviewArtifacts(input)
    const artifact = selected
      ? artifacts.find(option => option.key === selected) ?? null
      : null

    return {
      data: {
        selected,
        artifact,
      },
    }
  },
  mapToolResultToToolResultBlockParam({ artifact, selected }, toolUseID) {
    const content = artifact
      ? `User selected review artifact "${artifact.label}"${artifact.url ? ` (${artifact.url})` : ''}. Continue using that artifact.`
      : selected
        ? `Artifact key "${selected}" was approved, but no matching artifact metadata was available.`
        : 'Review artifact approval completed without a selection. Continue without assuming the user picked an artifact.'

    return {
      type: 'tool_result',
      content,
      tool_use_id: toolUseID,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
