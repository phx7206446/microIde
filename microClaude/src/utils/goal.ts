import { randomUUID } from 'crypto'
import {
  getTotalCacheCreationInputTokens,
  getTotalCacheReadInputTokens,
  getTotalCost,
  getTotalInputTokens,
  getTotalOutputTokens,
} from '../cost-tracker.js'
import type { AppState } from '../state/AppState.js'
import type {
  AchievedGoal,
  ActiveGoal,
  GoalState,
  GoalTokenSnapshot,
  GoalTranscriptEntry,
} from '../types/goal.js'
import { checkHasTrustDialogAccepted } from './config.js'
import { formatDuration, formatNumber } from './format.js'
import {
  shouldAllowManagedHooksOnly,
  shouldDisableAllHooksIncludingManaged,
} from './hooks/hooksConfigSnapshot.js'
import { logError } from './log.js'
import type { HookCommand, PromptHook } from './settings/types.js'

export const GOAL_CONDITION_MAX_LENGTH = 4000
export const GOAL_HOOK_MARKER = '<!-- claude-code-goal-hook:v1 -->'

const GOAL_HOOK_TIMEOUT_SECONDS = 60

export function isGoalHook(hook: HookCommand | { type: string }): boolean {
  return (
    hook.type === 'prompt' &&
    typeof (hook as Partial<PromptHook>).prompt === 'string' &&
    (hook as PromptHook).prompt.includes(GOAL_HOOK_MARKER)
  )
}

export function createGoalHook(condition: string): PromptHook {
  return {
    type: 'prompt',
    prompt: buildGoalPrompt(condition),
    timeout: GOAL_HOOK_TIMEOUT_SECONDS,
    statusMessage: 'Evaluating /goal',
  }
}

export function buildGoalPrompt(condition: string): string {
  return `${GOAL_HOOK_MARKER}
You are evaluating whether Claude Code has satisfied the active session goal.

Goal:
${condition}

Use the conversation history and the Stop hook input below. Return exactly one JSON object:
- {"ok": true} if the goal is fully satisfied and Claude should stop.
- {"ok": false, "reason": "..."} if more work is needed.

The reason must be concise, actionable feedback for Claude's next turn. Do not mark the goal satisfied for partial progress, plans, promises, or unverified claims unless the goal only asked for that.

Stop hook input:
$ARGUMENTS`
}

export function createActiveGoal(condition: string): ActiveGoal {
  return {
    id: randomUUID(),
    condition,
    startedAt: Date.now(),
    turnCount: 0,
    tokenBaseline: getCurrentGoalTokenSnapshot(),
  }
}

export function createGoalDirective(condition: string): string {
  return [
    `A session goal is now active: ${condition}`,
    '',
    'Continue working toward this goal. When you believe it is complete, stop normally; the /goal Stop hook will evaluate it. If the hook returns feedback, address that feedback and continue.',
  ].join('\n')
}

export function isGoalClearArgument(arg: string): boolean {
  return ['clear', 'stop', 'off', 'reset', 'cancel', 'none'].includes(
    arg.trim().toLowerCase(),
  )
}

export function getGoalActivationBlockReason(): string | undefined {
  if (!checkHasTrustDialogAccepted()) {
    return '/goal requires workspace trust because it installs a session Stop hook. Accept the workspace trust prompt before setting a goal.'
  }

  if (shouldDisableAllHooksIncludingManaged()) {
    return '/goal requires hooks, but hooks are disabled by managed settings.'
  }

  if (shouldAllowManagedHooksOnly()) {
    return '/goal requires a session-scoped hook, but this session only allows managed hooks.'
  }

  return undefined
}

export function removeGoalHooksFromState(
  state: AppState,
  sessionId: string,
): AppState {
  const store = state.sessionHooks.get(sessionId)
  if (!store) return state

  const stopMatchers = store.hooks.Stop ?? []
  if (stopMatchers.length === 0) return state

  let changed = false
  const updatedStopMatchers = stopMatchers
    .map(matcher => {
      const hooks = matcher.hooks.filter(entry => !isGoalHook(entry.hook))
      if (hooks.length !== matcher.hooks.length) changed = true
      return hooks.length > 0 ? { ...matcher, hooks } : null
    })
    .filter((matcher): matcher is NonNullable<typeof matcher> => matcher !== null)

  if (!changed) return state

  const hooks = { ...store.hooks }
  if (updatedStopMatchers.length > 0) {
    hooks.Stop = updatedStopMatchers
  } else {
    delete hooks.Stop
  }
  const sessionHooks = new Map(state.sessionHooks)
  sessionHooks.set(sessionId, { ...store, hooks })
  return { ...state, sessionHooks }
}

export function installGoalHookInState(
  state: AppState,
  sessionId: string,
  goal: ActiveGoal,
): AppState {
  const baseState = removeGoalHooksFromState(state, sessionId)

  const store = baseState.sessionHooks.get(sessionId) ?? { hooks: {} }
  const stopMatchers = store.hooks.Stop ?? []
  const hook = createGoalHook(goal.condition)
  const matcherIndex = stopMatchers.findIndex(
    matcher => matcher.matcher === '' && matcher.skillRoot === undefined,
  )

  const updatedStopMatchers =
    matcherIndex >= 0
      ? stopMatchers.map((matcher, index) =>
          index === matcherIndex
            ? { ...matcher, hooks: [...matcher.hooks, { hook }] }
            : matcher,
        )
      : [...stopMatchers, { matcher: '', hooks: [{ hook }] }]

  const sessionHooks = new Map(baseState.sessionHooks)
  sessionHooks.set(sessionId, {
    ...store,
    hooks: { ...store.hooks, Stop: updatedStopMatchers },
  })
  return { ...baseState, sessionHooks }
}

export function registerGoalStopHook(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  sessionId: string,
  goal: ActiveGoal,
): void {
  setAppState(prev => ({
    ...installGoalHookInState(prev, sessionId, goal),
    goal: {
      lastAchieved: prev.goal?.lastAchieved,
      active: goal,
    },
  }))
}

export function clearGoalFromState(
  state: AppState,
  sessionId: string,
): AppState {
  return {
    ...removeGoalHooksFromState(state, sessionId),
    goal: {},
  }
}

export function clearActiveGoalFromState(
  state: AppState,
  sessionId: string,
): AppState {
  const nextState = removeGoalHooksFromState(state, sessionId)
  return {
    ...nextState,
    goal: nextState.goal?.lastAchieved
      ? { lastAchieved: nextState.goal.lastAchieved }
      : {},
  }
}

export function markGoalUnmetInState(
  state: AppState,
  reason: string | undefined,
): AppState {
  const active = state.goal?.active
  if (!active) return state

  return {
    ...state,
    goal: {
      ...state.goal,
      active: {
        ...active,
        turnCount: active.turnCount + 1,
        lastReason: normalizeGoalReason(reason),
        lastEvaluatedAt: Date.now(),
      },
    },
  }
}

export function markGoalAchievedInState(
  state: AppState,
  sessionId: string,
  finalReason?: string,
): { state: AppState; achieved?: AchievedGoal } {
  const active = state.goal?.active
  if (!active) {
    return { state: removeGoalHooksFromState(state, sessionId) }
  }

  const achieved: AchievedGoal = {
    id: active.id,
    condition: active.condition,
    startedAt: active.startedAt,
    completedAt: Date.now(),
    turnCount: active.turnCount + 1,
    tokenBaseline: active.tokenBaseline,
    tokenSpend: active.tokenBaseline
      ? diffGoalTokenSnapshots(getCurrentGoalTokenSnapshot(), active.tokenBaseline)
      : undefined,
    finalReason: normalizeGoalReason(finalReason),
  }

  return {
    achieved,
    state: {
      ...removeGoalHooksFromState(state, sessionId),
      goal: {
        lastAchieved: achieved,
      },
    },
  }
}

export function restoreActiveGoalFromTranscript(
  entry: GoalTranscriptEntry | undefined,
): ActiveGoal | undefined {
  if (entry?.status !== 'active') return undefined
  const condition = entry.condition?.trim()
  if (!condition) return undefined

  return createActiveGoal(condition)
}

export function restoreGoalIntoState(
  state: AppState,
  entry: GoalTranscriptEntry | undefined,
  sessionId: string | undefined,
): AppState {
  if (!sessionId) return state
  const active = restoreActiveGoalFromTranscript(entry)
  if (!active) {
    return clearGoalFromState(state, sessionId)
  }
  return {
    ...installGoalHookInState(state, sessionId, active),
    goal: { active },
  }
}

export function formatGoalStatus(goal: GoalState | undefined): string {
  if (goal?.active) {
    const active = goal.active
    return [
      'Active goal:',
      active.condition,
      '',
      `Duration: ${formatDuration(Date.now() - active.startedAt, { mostSignificantOnly: true })}`,
      `Evaluated turns: ${active.turnCount}`,
      `Token spend: ${formatGoalTokenSpend(active.tokenBaseline)}`,
      active.lastReason ? `Last feedback: ${active.lastReason}` : undefined,
    ]
      .filter(Boolean)
      .join('\n')
  }

  if (goal?.lastAchieved) {
    const achieved = goal.lastAchieved
    return [
      'Last achieved goal:',
      achieved.condition,
      '',
      `Duration: ${formatDuration(achieved.completedAt - achieved.startedAt, { mostSignificantOnly: true })}`,
      `Evaluated turns: ${achieved.turnCount}`,
      `Token spend: ${formatGoalTokenSnapshot(achieved.tokenSpend)}`,
      achieved.finalReason ? `Final note: ${achieved.finalReason}` : undefined,
    ]
      .filter(Boolean)
      .join('\n')
  }

  return 'No active goal. Usage: /goal <condition>'
}

export function persistGoalActive(sessionId: string, goal: ActiveGoal): void {
  persistGoalEntry(sessionId, {
    status: 'active',
    id: goal.id,
    condition: goal.condition,
    startedAt: goal.startedAt,
    turnCount: goal.turnCount,
    lastReason: goal.lastReason,
    lastEvaluatedAt: goal.lastEvaluatedAt,
    tokenBaseline: goal.tokenBaseline,
  })
}

export function persistGoalAchieved(
  sessionId: string,
  goal: AchievedGoal,
): void {
  persistGoalEntry(sessionId, {
    status: 'achieved',
    id: goal.id,
    condition: goal.condition,
    startedAt: goal.startedAt,
    completedAt: goal.completedAt,
    turnCount: goal.turnCount,
    tokenBaseline: goal.tokenBaseline,
    tokenSpend: goal.tokenSpend,
    finalReason: goal.finalReason,
  })
}

export function persistGoalCleared(sessionId: string): void {
  persistGoalEntry(sessionId, { status: 'cleared' })
}

function persistGoalEntry(
  sessionId: string,
  entry: Omit<GoalTranscriptEntry, 'type' | 'sessionId' | 'timestamp'>,
): void {
  void import('./sessionStorage.js')
    .then(({ recordGoalState }) => recordGoalState(sessionId, entry))
    .catch(error => logError(error))
}

function getCurrentGoalTokenSnapshot(): GoalTokenSnapshot {
  const inputTokens = getTotalInputTokens()
  const outputTokens = getTotalOutputTokens()
  const cacheReadInputTokens = getTotalCacheReadInputTokens()
  const cacheCreationInputTokens = getTotalCacheCreationInputTokens()
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    totalTokens:
      inputTokens +
      outputTokens +
      cacheReadInputTokens +
      cacheCreationInputTokens,
    costUSD: getTotalCost(),
  }
}

function diffGoalTokenSnapshots(
  current: GoalTokenSnapshot,
  baseline: GoalTokenSnapshot,
): GoalTokenSnapshot {
  return {
    inputTokens: Math.max(0, current.inputTokens - baseline.inputTokens),
    outputTokens: Math.max(0, current.outputTokens - baseline.outputTokens),
    cacheReadInputTokens: Math.max(
      0,
      current.cacheReadInputTokens - baseline.cacheReadInputTokens,
    ),
    cacheCreationInputTokens: Math.max(
      0,
      current.cacheCreationInputTokens - baseline.cacheCreationInputTokens,
    ),
    totalTokens: Math.max(0, current.totalTokens - baseline.totalTokens),
    costUSD:
      current.costUSD === undefined || baseline.costUSD === undefined
        ? undefined
        : Math.max(0, current.costUSD - baseline.costUSD),
  }
}

function formatGoalTokenSpend(
  baseline: GoalTokenSnapshot | undefined,
): string {
  if (!baseline) return 'unavailable'
  return formatGoalTokenSnapshot(
    diffGoalTokenSnapshots(getCurrentGoalTokenSnapshot(), baseline),
  )
}

function formatGoalTokenSnapshot(
  snapshot: GoalTokenSnapshot | undefined,
): string {
  if (!snapshot) return 'unavailable'

  const parts = [
    `${formatNumber(snapshot.totalTokens)} total`,
    `${formatNumber(snapshot.inputTokens)} input`,
    `${formatNumber(snapshot.outputTokens)} output`,
    `${formatNumber(snapshot.cacheReadInputTokens)} cache read`,
    `${formatNumber(snapshot.cacheCreationInputTokens)} cache write`,
  ]
  if (snapshot.costUSD !== undefined) {
    parts.push(`$${snapshot.costUSD.toFixed(snapshot.costUSD > 0.5 ? 2 : 4)}`)
  }
  return parts.join(', ')
}

function normalizeGoalReason(reason: string | undefined): string | undefined {
  const trimmed = reason?.trim()
  return trimmed ? trimmed : undefined
}
