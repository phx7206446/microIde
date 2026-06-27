import { getSessionId } from '../../bootstrap/state.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import type { ToolUseContext } from '../../Tool.js'
import {
  createActiveGoal,
  createGoalDirective,
  formatGoalStatus,
  getGoalActivationBlockReason,
  GOAL_CONDITION_MAX_LENGTH,
  isGoalClearArgument,
  persistGoalActive,
  persistGoalCleared,
  registerGoalStopHook,
  clearActiveGoalFromState,
} from '../../utils/goal.js'

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: ToolUseContext & LocalJSXCommandContext,
  args: string,
): Promise<null> {
  const condition = args.trim()

  if (!condition) {
    onDone(formatGoalStatus(context.getAppState().goal), { display: 'system' })
    return null
  }

  if (isGoalClearArgument(condition)) {
    const sessionId = getSessionId()
    const hadActiveGoal = Boolean(context.getAppState().goal?.active)
    context.setAppState(prev => clearActiveGoalFromState(prev, sessionId))
    if (hadActiveGoal) persistGoalCleared(sessionId)
    onDone('Goal cleared.', { display: 'system' })
    return null
  }

  if (condition.length > GOAL_CONDITION_MAX_LENGTH) {
    onDone(
      `Goal is too long (${condition.length} chars). Keep it under ${GOAL_CONDITION_MAX_LENGTH} chars.`,
      { display: 'system' },
    )
    return null
  }

  const blockReason = getGoalActivationBlockReason()
  if (blockReason) {
    onDone(blockReason, { display: 'system' })
    return null
  }

  const sessionId = getSessionId()
  const goal = createActiveGoal(condition)
  registerGoalStopHook(context.setAppState, sessionId, goal)
  persistGoalActive(sessionId, goal)

  onDone(`Goal set: ${condition}`, {
    display: 'system',
    shouldQuery: true,
    metaMessages: [createGoalDirective(condition)],
  })
  return null
}
