import type { UUID } from 'crypto'

export type GoalTokenSnapshot = {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  totalTokens: number
  costUSD?: number
}

export type ActiveGoal = {
  id: string
  condition: string
  startedAt: number
  turnCount: number
  tokenBaseline?: GoalTokenSnapshot
  lastReason?: string
  lastEvaluatedAt?: number
}

export type AchievedGoal = {
  id: string
  condition: string
  startedAt: number
  completedAt: number
  turnCount: number
  tokenBaseline?: GoalTokenSnapshot
  tokenSpend?: GoalTokenSnapshot
  finalReason?: string
}

export type GoalState = {
  active?: ActiveGoal
  lastAchieved?: AchievedGoal
}

export type GoalTranscriptStatus = 'active' | 'achieved' | 'cleared'

export type GoalTranscriptEntry = {
  type: 'goal-state'
  sessionId: UUID
  status: GoalTranscriptStatus
  timestamp: string
  id?: string
  condition?: string
  startedAt?: number
  completedAt?: number
  turnCount?: number
  lastReason?: string
  lastEvaluatedAt?: number
  tokenBaseline?: GoalTokenSnapshot
  tokenSpend?: GoalTokenSnapshot
  finalReason?: string
}
