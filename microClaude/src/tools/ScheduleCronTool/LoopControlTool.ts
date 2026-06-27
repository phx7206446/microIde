import { z } from 'zod/v4'
import type { ValidationResult } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import {
  completeLoopTask,
  continueDynamicLoopTask,
  isDynamicLoopTask,
  LOOP_CONTROL_TOOL_NAME,
  LOOP_MAX_AGE_DAYS,
} from '../../utils/loopTasks.js'
import { getSessionCronTasks } from '../../bootstrap/state.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getTeammateContext } from '../../utils/teammateContext.js'
import { isKairosCronEnabled } from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    id: z.string().describe('Dynamic /loop ID.'),
    action: z
      .enum(['continue', 'complete'])
      .describe('continue schedules the next wake-up; complete ends the loop.'),
    delayMinutes: z
      .number()
      .int()
      .min(1)
      .max(60)
      .optional()
      .describe('Required for continue. Next wake-up delay from 1 to 60 minutes.'),
    reason: z
      .string()
      .optional()
      .describe('Concise reason for the selected delay.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    id: z.string(),
    action: z.enum(['continue', 'complete']),
    delayMinutes: z.number().optional(),
    nextFireAt: z.number().optional(),
    reason: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type LoopControlOutput = z.infer<OutputSchema>

export const LoopControlTool = buildTool({
  name: LOOP_CONTROL_TOOL_NAME,
  searchHint: 'continue or complete a dynamic loop wake-up',
  maxResultSizeChars: 20_000,
  alwaysLoad: true,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    return isKairosCronEnabled()
  },
  isConcurrencySafe() {
    return false
  },
  async description() {
    return 'Continue or complete a dynamic /loop task. Use only when a /loop prompt asks you to choose the next wake-up.'
  },
  async prompt() {
    return `Controls a dynamic /loop task.

Use this at the end of each dynamic /loop iteration:
- action "continue": provide delayMinutes from 1 to 60 and a short reason.
- action "complete": end the loop when no further wake-up is needed.

Dynamic /loop tasks are session-scoped and expire after ${LOOP_MAX_AGE_DAYS} days.`
  },
  async validateInput(input): Promise<ValidationResult> {
    const task = getSessionCronTasks().find(t => t.id === input.id)
    if (!task || !isDynamicLoopTask(task)) {
      return {
        result: false,
        message: `No dynamic /loop task with id '${input.id}'`,
        errorCode: 1,
      }
    }

    const ctx = getTeammateContext()
    if (ctx && task.agentId !== ctx.agentId) {
      return {
        result: false,
        message: `Cannot control /loop '${input.id}': owned by another agent`,
        errorCode: 2,
      }
    }

    if (input.action === 'continue') {
      if (typeof input.delayMinutes !== 'number') {
        return {
          result: false,
          message: 'delayMinutes is required when action is "continue"',
          errorCode: 3,
        }
      }
    }

    return { result: true }
  },
  async call({ id, action, delayMinutes, reason }) {
    if (action === 'complete') {
      await completeLoopTask(id)
      return { data: { id, action } }
    }

    const updated = await continueDynamicLoopTask({
      id,
      delayMinutes: delayMinutes!,
      ...(reason ? { reason } : {}),
    })
    return {
      data: {
        id,
        action,
        delayMinutes,
        nextFireAt: updated?.nextFireAt,
        ...(reason ? { reason } : {}),
      },
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const content =
      output.action === 'complete'
        ? `Loop ${output.id} completed.`
        : `Loop ${output.id} will wake in ${output.delayMinutes} minute(s)${output.reason ? `: ${output.reason}` : ''}.`
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content,
    }
  },
  renderToolUseMessage(input) {
    return `${input.action ?? ''} ${input.id ?? ''}`.trim()
  },
  renderToolResultMessage(output) {
    return output.action === 'complete'
      ? `Loop ${output.id} completed`
      : `Loop ${output.id} scheduled`
  },
} satisfies ToolDef<InputSchema, LoopControlOutput>)
