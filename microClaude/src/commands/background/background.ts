import {
  createAgentJob,
  getCurrentSessionIdForBackground,
} from '../../utils/agentView.js'
import { gracefulShutdown } from '../../utils/gracefulShutdown.js'
import type {
  LocalCommandResult,
  LocalJSXCommandContext,
} from '../../types/command.js'

export async function call(
  args: string,
  context: LocalJSXCommandContext,
): Promise<LocalCommandResult> {
  const runningBackgroundTasks = Object.values(
    (context as { tasks?: Record<string, { status?: string }> }).tasks ?? {},
  ).filter(task => task.status === 'running').length
  if (runningBackgroundTasks > 0 && !args.includes('--force')) {
    return {
      type: 'text',
      value:
        `There ${runningBackgroundTasks === 1 ? 'is' : 'are'} ${runningBackgroundTasks} running background task${runningBackgroundTasks === 1 ? '' : 's'}. ` +
        'Run /bg --force to background this session anyway. Running subagents, monitors, and background commands are not moved into Agent View.',
    }
  }
  const prompt =
    args.replace('--force', '').trim() || 'Continue this session in the background.'
  const state = await createAgentJob({
    cwd: process.cwd(),
    rootCwd: process.cwd(),
    prompt,
    args: [],
    resumeSessionId: getCurrentSessionIdForBackground(),
  })
  await gracefulShutdown(0, 'other', {
    finalMessage: `Backgrounded current session as ${state.id}. Use \`claude agents\` to view it.`,
  })
  return { type: 'skip' }
}
