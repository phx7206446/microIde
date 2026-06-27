import React from 'react'
import { z } from 'zod/v4'
import { Box, Text } from '../../ink.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { collectContextData } from '../../commands/context/context-noninteractive.js'
import {
  getStats,
  isContextCollapseEnabled,
} from '../../services/contextCollapse/index.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { formatTokens } from '../../utils/format.js'

export const CTX_INSPECT_TOOL_NAME = 'CtxInspect'

const DESCRIPTION =
  'Inspect the current model-facing context and context-collapse runtime state.'

const inputSchema = lazySchema(() => z.strictObject({}))
type InputSchema = ReturnType<typeof inputSchema>

const categorySchema = z.object({
  name: z.string(),
  tokens: z.number().int(),
})

const outputSchema = lazySchema(() =>
  z.object({
    model: z.string(),
    total_tokens: z.number().int(),
    raw_max_tokens: z.number().int(),
    percentage: z.number(),
    collapse_enabled: z.boolean(),
    collapse_stats: z.object({
      collapsed_spans: z.number().int(),
      collapsed_messages: z.number().int(),
      staged_spans: z.number().int(),
      total_spawns: z.number().int(),
      total_errors: z.number().int(),
      total_empty_spawns: z.number().int(),
    }),
    top_categories: z.array(categorySchema),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
type Output = z.infer<OutputSchema>

function buildResultText(output: Output): string {
  const categoryLines =
    output.top_categories.length === 0
      ? ['- none']
      : output.top_categories.map(
          category => `- ${category.name}: ${formatTokens(category.tokens)}`,
        )

  return [
    `Model: ${output.model}`,
    `Context: ${formatTokens(output.total_tokens)} / ${formatTokens(output.raw_max_tokens)} (${output.percentage.toFixed(1)}%)`,
    `Context collapse: ${output.collapse_enabled ? 'enabled' : 'disabled'}`,
    `Collapse stats: ${output.collapse_stats.collapsed_spans} collapsed spans, ${output.collapse_stats.staged_spans} staged, ${output.collapse_stats.total_spawns} spawns, ${output.collapse_stats.total_errors} errors`,
    'Top categories:',
    ...categoryLines,
  ].join('\n')
}

export const CtxInspectTool = buildTool({
  name: CTX_INSPECT_TOOL_NAME,
  searchHint: 'inspect context usage and collapse state',
  maxResultSizeChars: 20_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return DESCRIPTION
  },
  renderToolUseMessage() {
    return <Text>Inspecting current context state</Text>
  },
  renderToolResultMessage(output) {
    return (
      <Box flexDirection="column">
        <Text>
          {formatTokens(output.total_tokens)} / {formatTokens(output.raw_max_tokens)} ({output.percentage.toFixed(1)}%)
        </Text>
        <Text dimColor>
          Collapse {output.collapse_enabled ? 'enabled' : 'disabled'};{' '}
          {output.collapse_stats.collapsed_spans} collapsed /{' '}
          {output.collapse_stats.staged_spans} staged
        </Text>
      </Box>
    )
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: buildResultText(output),
    }
  },
  async call(_input, context) {
    const data = await collectContextData(context)
    const stats = getStats()

    return {
      data: {
        model: data.model,
        total_tokens: data.totalTokens,
        raw_max_tokens: data.rawMaxTokens,
        percentage: data.percentage,
        collapse_enabled: isContextCollapseEnabled(),
        collapse_stats: {
          collapsed_spans: stats.collapsedSpans,
          collapsed_messages: stats.collapsedMessages,
          staged_spans: stats.stagedSpans,
          total_spawns: stats.health.totalSpawns,
          total_errors: stats.health.totalErrors,
          total_empty_spawns: stats.health.totalEmptySpawns,
        },
        top_categories: data.categories
          .filter(category => category.tokens > 0)
          .slice(0, 5)
          .map(category => ({
            name: category.name,
            tokens: category.tokens,
          })),
      },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
