import { cronToHuman } from './cron.js'

type MissedTaskLike = {
  cron: string
  prompt: string
  createdAt: number
}

/**
 * Build the missed-task notification text. Guidance precedes the task list
 * and the list is wrapped in a code fence so a multi-line imperative prompt
 * is not interpreted as immediate instructions to avoid self-inflicted
 * prompt injection. The full prompt body is preserved because this path
 * needs the model to execute the prompt after user confirmation.
 */
export function buildMissedTaskNotification(
  missed: readonly MissedTaskLike[],
): string {
  const plural = missed.length > 1
  const header =
    `The following one-shot scheduled task${plural ? 's were' : ' was'} missed while Claude was not running. ` +
    `${plural ? 'They have' : 'It has'} already been removed from .claude/scheduled_tasks.json.\n\n` +
    `Do NOT execute ${plural ? 'these prompts' : 'this prompt'} yet. ` +
    `First use the AskUserQuestion tool to ask whether to run ${plural ? 'each one' : 'it'} now. ` +
    `Only execute if the user confirms.`

  const blocks = missed.map(task => {
    const meta = `[${cronToHuman(task.cron)}, created ${new Date(task.createdAt).toLocaleString()}]`
    const backtickRuns: string[] = task.prompt.match(/`+/g) ?? []
    const longestRun = backtickRuns.reduce(
      (max, run) => Math.max(max, run.length),
      0,
    )
    const fence = '`'.repeat(Math.max(3, longestRun + 1))
    return `${meta}\n${fence}\n${task.prompt}\n${fence}`
  })

  return `${header}\n\n${blocks.join('\n\n')}`
}
