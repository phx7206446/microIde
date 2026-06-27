import React from 'react'
import { z } from 'zod/v4'
import type { ProgressMessage } from '../../types/message.js'
import type { SleepProgress } from '../../types/tools.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { Box, Text } from '../../ink.js'
import { hasCommandsInQueue } from '../../utils/messageQueueManager.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getSettings_DEPRECATED } from '../../utils/settings/settings.js'
import { sleep } from '../../utils/sleep.js'
import { formatDuration } from '../../utils/format.js'
import { isProactiveActive } from '../../proactive/index.js'
import { DESCRIPTION, SLEEP_TOOL_NAME, SLEEP_TOOL_PROMPT } from './prompt.js'

const POLL_INTERVAL_MS = 1_000

const inputSchema = lazySchema(() =>
  z.strictObject({
    duration_ms: z
      .number()
      .int()
      .min(0)
      .describe('How long to wait in milliseconds before waking up.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    requestedMs: z.number().int(),
    sleptMs: z.number().int(),
    remainingMs: z.number().int(),
    wokeForQueuedCommand: z.boolean(),
    interrupted: z.boolean(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

type Output = z.infer<OutputSchema>

function clampDuration(durationMs: number): number {
  const settings = getSettings_DEPRECATED() || {}
  const minSleep = Math.max(0, settings.minSleepDurationMs ?? 0)
  const maxSleep = settings.maxSleepDurationMs ?? undefined
  let clamped = Math.max(minSleep, durationMs)
  if (typeof maxSleep === 'number' && maxSleep >= 0) {
    clamped = Math.min(clamped, maxSleep)
  }
  return clamped
}

function renderToolUseProgressMessage(
  progressMessages: ProgressMessage<SleepProgress>[],
): React.ReactNode {
  const latest = progressMessages.at(-1)?.data
  if (!latest) {
    return null
  }

  const remainingText =
    latest.remainingMs > 0 ? formatDuration(latest.remainingMs) : 'ready'

  return (
    <Box>
      <Text dimColor>Waiting {remainingText}</Text>
    </Box>
  )
}

export const SleepTool = buildTool({
  name: SLEEP_TOOL_NAME,
  searchHint: 'wait until the next autonomous check-in',
  maxResultSizeChars: 10_000,
  alwaysLoad: true,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    return isProactiveActive()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  interruptBehavior() {
    return 'cancel'
  },
  async description(input) {
    return `${DESCRIPTION} (${clampDuration(input.duration_ms)}ms)`
  },
  async prompt() {
    return SLEEP_TOOL_PROMPT
  },
  renderToolUseMessage() {
    return ''
  },
  renderToolUseProgressMessage(progressMessages) {
    return renderToolUseProgressMessage(progressMessages)
  },
  renderToolResultMessage() {
    return null
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const suffix = output.interrupted
      ? 'Interrupted.'
      : output.wokeForQueuedCommand
        ? 'Woke early for queued work.'
        : 'Finished waiting.'

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: suffix,
    }
  },
  async call(input, context, _canUseTool, _parentMessage, onProgress) {
    const abortSignal = context.abortController.signal
    const progressToolUseID = `${context.toolUseId ?? SLEEP_TOOL_NAME}-progress`
    const requestedMs = clampDuration(input.duration_ms)
    const startedAt = Date.now()
    let sleptMs = 0
    let wokeForQueuedCommand = false

    while (sleptMs < requestedMs) {
      if (abortSignal.aborted) {
        break
      }
      if (hasCommandsInQueue()) {
        wokeForQueuedCommand = true
        break
      }

      const remainingMs = Math.max(0, requestedMs - sleptMs)
      const sliceMs = Math.min(POLL_INTERVAL_MS, remainingMs)
      await sleep(sliceMs, abortSignal)

      sleptMs = Math.min(requestedMs, Date.now() - startedAt)
      if (abortSignal.aborted) {
        break
      }
      if (hasCommandsInQueue()) {
        wokeForQueuedCommand = true
        break
      }
      onProgress?.({
        toolUseID: progressToolUseID,
        data: {
          type: 'sleep_progress',
          requestedMs,
          sleptMs,
          remainingMs: Math.max(0, requestedMs - sleptMs),
        },
      })
    }

    const finalSleptMs = Math.min(requestedMs, Date.now() - startedAt)

    return {
      data: {
        requestedMs,
        sleptMs: finalSleptMs,
        remainingMs: Math.max(0, requestedMs - finalSleptMs),
        wokeForQueuedCommand,
        interrupted: abortSignal.aborted,
      },
    }
  },
} satisfies ToolDef<InputSchema, Output, SleepProgress>)
