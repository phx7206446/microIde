import {
  buildLoopStartPrompt,
  createDynamicLoopTask,
  createFixedLoopTask,
  intervalToSchedule,
  LOOP_PROVIDER_FALLBACK_INTERVAL,
  parseLoopCommand,
} from '../../utils/loopTasks.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import { isKairosCronEnabled } from '../../tools/ScheduleCronTool/prompt.js'
import { registerBundledSkill } from '../bundledSkills.js'

const USAGE_MESSAGE = `Usage: /loop [interval] [prompt]

Run a prompt repeatedly in this session.

Forms:
  /loop 5m "check the deploy"     Fixed interval loop
  /loop "check the deploy"        Dynamic loop; Claude chooses 1m-1h after each iteration
  /loop                           Dynamic maintenance loop
  /loop 15m                       Fixed interval maintenance loop

Maintenance prompt override:
  .claude/loop.md                 Project-level override
  ~/.claude/loop.md               User-level fallback

Intervals: Ns, Nm, Nh, Nd. Cron-backed fixed loops use minute granularity.`

function isProviderDynamicFallback(): boolean {
  const provider = getAPIProvider()
  return provider === 'bedrock' || provider === 'vertex' || provider === 'foundry'
}

export function registerLoopSkill(): void {
  registerBundledSkill({
    name: 'loop',
    description:
      'Run a prompt repeatedly in this session, either at a fixed interval or dynamically with Claude choosing each next wake-up.',
    whenToUse:
      'When the user asks to keep checking, keep monitoring, run a prompt repeatedly, or start a maintenance loop. Do NOT invoke for one-off reminders.',
    argumentHint: '[interval] [prompt]',
    userInvocable: true,
    isEnabled: isKairosCronEnabled,
    async getPromptForCommand(args, context) {
      const parsed = parseLoopCommand(args)
      const agentId = context.agentId

      if (parsed.mode === 'dynamic') {
        if (isProviderDynamicFallback()) {
          if (parsed.promptSource === 'maintenance') {
            return [{ type: 'text', text: USAGE_MESSAGE }]
          }

          const schedule = intervalToSchedule(LOOP_PROVIDER_FALLBACK_INTERVAL)
          const task = await createFixedLoopTask({
            schedule,
            prompt: parsed.prompt,
            promptSource: parsed.promptSource,
            ...(agentId ? { agentId } : {}),
          })
          return [
            {
              type: 'text',
              text: buildLoopStartPrompt({
                task,
                parsed: { ...parsed, interval: LOOP_PROVIDER_FALLBACK_INTERVAL, mode: 'fixed' },
                schedule,
                fallbackReason:
                  'Current provider does not support dynamic loop timing; using a fixed 10m loop instead.',
              }),
            },
          ]
        }

        const task = await createDynamicLoopTask({
          prompt: parsed.prompt,
          promptSource: parsed.promptSource,
          ...(agentId ? { agentId } : {}),
        })
        return [
          {
            type: 'text',
            text: buildLoopStartPrompt({ task, parsed }),
          },
        ]
      }

      if (!parsed.interval) {
        return [{ type: 'text', text: USAGE_MESSAGE }]
      }

      let schedule
      try {
        schedule = intervalToSchedule(parsed.interval)
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        return [{ type: 'text', text: `${USAGE_MESSAGE}\n\n${message}` }]
      }

      const task = await createFixedLoopTask({
        schedule,
        prompt: parsed.prompt,
        promptSource: parsed.promptSource,
        ...(agentId ? { agentId } : {}),
      })
      return [
        {
          type: 'text',
          text: buildLoopStartPrompt({ task, parsed, schedule }),
        },
      ]
    },
  })
}
