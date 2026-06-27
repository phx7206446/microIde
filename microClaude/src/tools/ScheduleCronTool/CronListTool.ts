import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { cronToHuman } from '../../utils/cron.js'
import { listAllCronTasks } from '../../utils/cronTasks.js'
import { truncate } from '../../utils/format.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  describeLoopTask,
  isDynamicLoopTask,
  isLoopTask,
} from '../../utils/loopTasks.js'
import { getTeammateContext } from '../../utils/teammateContext.js'
import {
  buildCronListPrompt,
  CRON_LIST_DESCRIPTION,
  CRON_LIST_TOOL_NAME,
  isDurableCronEnabled,
  isKairosCronEnabled,
} from './prompt.js'
import { renderListResultMessage, renderListToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() => z.strictObject({}))
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    jobs: z.array(
      z.object({
        id: z.string(),
        kind: z.enum(['cron', 'loop']),
        cron: z.string().optional(),
        humanSchedule: z.string(),
        prompt: z.string(),
        recurring: z.boolean().optional(),
        durable: z.boolean().optional(),
        loopMode: z.enum(['fixed', 'dynamic']).optional(),
        nextWakeAt: z.number().optional(),
      }),
    ),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type ListOutput = z.infer<OutputSchema>

export const CronListTool = buildTool({
  name: CRON_LIST_TOOL_NAME,
  searchHint: 'list active cron and loop jobs',
  maxResultSizeChars: 100_000,
  shouldDefer: true,
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
    return true
  },
  isReadOnly() {
    return true
  },
  async description() {
    return CRON_LIST_DESCRIPTION
  },
  async prompt() {
    return buildCronListPrompt(isDurableCronEnabled())
  },
  async call() {
    const allTasks = await listAllCronTasks()
    // Teammates only see their own jobs; team lead (no ctx) sees all.
    const ctx = getTeammateContext()
    const tasks = ctx
      ? allTasks.filter(t => t.agentId === ctx.agentId)
      : allTasks
    const jobs = tasks.map(t => ({
      id: t.id,
      kind: isLoopTask(t) ? ('loop' as const) : ('cron' as const),
      ...(typeof t.cron === 'string' ? { cron: t.cron } : {}),
      humanSchedule:
        isLoopTask(t) || typeof t.cron !== 'string'
          ? describeLoopTask(t)
          : cronToHuman(t.cron),
      prompt: t.prompt,
      ...(t.recurring ? { recurring: true } : {}),
      ...(t.durable === false ? { durable: false } : {}),
      ...(isLoopTask(t) ? { loopMode: t.loopMode } : {}),
      ...(isDynamicLoopTask(t) && typeof t.nextFireAt === 'number'
        ? { nextWakeAt: t.nextFireAt }
        : {}),
    }))
    return { data: { jobs } }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content:
        output.jobs.length > 0
          ? output.jobs.map(formatJobForToolResult).join('\n')
          : 'No scheduled jobs.',
    }
  },
  renderToolUseMessage: renderListToolUseMessage,
  renderToolResultMessage: renderListResultMessage,
} satisfies ToolDef<InputSchema, ListOutput>)

function formatJobForToolResult(job: ListOutput['jobs'][number]): string {
  return `${job.id} | ${job.kind} | ${job.humanSchedule}${job.recurring ? ' (recurring)' : ' (one-shot)'}${job.durable === false ? ' [session-only]' : ''}: ${truncate(job.prompt, 80, true)}`
}
