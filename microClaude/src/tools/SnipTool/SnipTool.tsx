import React from 'react'
import { z } from 'zod/v4'
import { Box, Text } from '../../ink.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { getMessagesAfterCompactBoundary } from '../../utils/messages.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  createSnipMarkerMessage,
  isSnipRuntimeEnabled,
  planSnipFromMessageIds,
} from '../../services/compact/snipCompact.js'
import { DESCRIPTION, SNIP_TOOL_NAME } from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    message_ids: z
      .array(z.string().min(1))
      .min(1)
      .describe('User message IDs from [id:xxxxxx] tags to remove from context'),
    reason: z
      .string()
      .trim()
      .max(280)
      .optional()
      .describe('Optional brief reason for why these turns are safe to remove'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    applied: z.boolean(),
    removed_turns: z.number().int(),
    removed_messages: z.number().int(),
    removed_message_ids: z.array(z.string()),
    skipped_message_ids: z.array(z.string()),
    estimated_tokens_freed: z.number().int(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
type Output = z.infer<OutputSchema>

function buildResultText(output: Output): string {
  if (!output.applied) {
    return output.skipped_message_ids.length > 0
      ? `No turns were snipped. Skipped IDs: ${output.skipped_message_ids.join(', ')}.`
      : 'No turns were snipped.'
  }

  const skipped =
    output.skipped_message_ids.length > 0
      ? ` Skipped: ${output.skipped_message_ids.join(', ')}.`
      : ''

  return `Queued snip of ${output.removed_turns} turn${output.removed_turns === 1 ? '' : 's'} (${output.removed_messages} messages, ~${output.estimated_tokens_freed} tokens).${skipped}`
}

export const SnipTool = buildTool({
  name: SNIP_TOOL_NAME,
  searchHint: 'remove stale conversation turns',
  maxResultSizeChars: 2_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    return isSnipRuntimeEnabled()
  },
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return false
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return DESCRIPTION
  },
  renderToolUseMessage(input) {
    return (
      <Text>
        Snipping {input.message_ids?.length ?? 0} selected turn
        {(input.message_ids?.length ?? 0) === 1 ? '' : 's'}
      </Text>
    )
  },
  renderToolResultMessage(output) {
    return (
      <Box flexDirection="column">
        <Text>{buildResultText(output)}</Text>
      </Box>
    )
  },
  getToolUseSummary(input) {
    const count = input?.message_ids?.length ?? 0
    return count > 0 ? `Snip ${count} turn${count === 1 ? '' : 's'}` : 'Snip'
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: buildResultText(output),
    }
  },
  async call(input, context) {
    const activeMessages = getMessagesAfterCompactBoundary(context.messages)
    const plan = planSnipFromMessageIds(
      activeMessages,
      input.message_ids,
      input.reason,
    )

    const output: Output = {
      applied: plan.removedUuids.length > 0,
      removed_turns: plan.removedMessageIds.length,
      removed_messages: plan.removedCount,
      removed_message_ids: plan.removedMessageIds,
      skipped_message_ids: plan.skippedMessageIds,
      estimated_tokens_freed: Math.max(0, Math.round(plan.tokensFreed)),
    }

    return {
      data: output,
      newMessages:
        plan.removedUuids.length > 0
          ? [createSnipMarkerMessage(plan)]
          : undefined,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
