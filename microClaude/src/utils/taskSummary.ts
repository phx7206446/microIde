import type { UUID } from 'crypto'
import type { Message } from '../types/message.js'
import type { SessionId } from '../types/ids.js'
import { createUserMessage } from './messages.js'
import type { CacheSafeParams } from './forkedAgent.js'
import { runForkedAgent } from './forkedAgent.js'
import { logForDebugging } from './debug.js'
import { saveTaskSummary } from './sessionStorage.js'
import { notifySessionMetadataChanged } from './sessionState.js'
import { getSessionId } from '../bootstrap/state.js'
import { createAgentId } from './uuid.js'

const MIN_STEP_DELTA = 5
const MIN_INTERVAL_MS = 2 * 60 * 1000
const MAX_SUMMARY_LENGTH = 80

const TASK_SUMMARY_PROMPT = `[TASK SUMMARY MODE]
Summarize what the agent is actively working on right now for a session list.

Rules:
- Output exactly one short line.
- Prefer 3-12 words when possible.
- Focus on the current task, not completed work.
- Be concrete: mention the file, command, bug, feature, or investigation when obvious.
- Start with the action when natural, e.g. "Editing src/query.ts" or "Running typecheck".
- No markdown, quotes, bullets, or trailing explanation.
- Maximum 80 characters.`

let trackedSessionId: SessionId | null = null
let lastSummaryAssistantCount = 0
let lastSummaryAt = 0
let lastSummaryText: string | null = null
let inFlightSummary: Promise<void> | null = null

function resetTaskSummaryState(sessionId: SessionId): void {
  trackedSessionId = sessionId
  lastSummaryAssistantCount = 0
  lastSummaryAt = 0
  lastSummaryText = null
  inFlightSummary = null
}

function ensureSessionState(): SessionId {
  const sessionId = getSessionId()
  if (trackedSessionId !== sessionId) {
    resetTaskSummaryState(sessionId)
  }
  return sessionId
}

function countAssistantMessages(messages: readonly Message[]): number {
  let total = 0
  for (const message of messages) {
    if (message.type === 'assistant') total++
  }
  return total
}

function extractSummaryText(messages: readonly Message[]): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.type !== 'assistant') continue

    const text = message.message.content
      .filter(
        (
          block,
        ): block is Extract<(typeof message.message.content)[number], { type: 'text' }> =>
          block.type === 'text',
      )
      .map(block => block.text)
      .join(' ')

    const normalized = normalizeSummary(text)
    if (normalized) return normalized
  }

  return null
}

function normalizeSummary(summary: string): string | null {
  const trimmed = summary
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[.!?]+$/, '')

  if (!trimmed) return null
  if (trimmed.length <= MAX_SUMMARY_LENGTH) return trimmed

  return `${trimmed.slice(0, MAX_SUMMARY_LENGTH - 3).trimEnd()}...`
}

export function shouldGenerateTaskSummary(): boolean {
  ensureSessionState()
  return !inFlightSummary
}

export function maybeGenerateTaskSummary(
  cacheSafeParams: CacheSafeParams,
): void {
  const sessionId = ensureSessionState()
  if (inFlightSummary) return

  const assistantCount = countAssistantMessages(cacheSafeParams.forkContextMessages)
  if (assistantCount <= lastSummaryAssistantCount) return

  const stepDelta = assistantCount - lastSummaryAssistantCount
  const now = Date.now()
  if (lastSummaryAt === 0) {
    if (stepDelta < MIN_STEP_DELTA) return
  } else if (
    stepDelta < MIN_STEP_DELTA &&
    now - lastSummaryAt < MIN_INTERVAL_MS
  ) {
    return
  }

  lastSummaryAssistantCount = assistantCount
  lastSummaryAt = now

  const task = generateTaskSummary(sessionId, cacheSafeParams).finally(() => {
    if (inFlightSummary === task) {
      inFlightSummary = null
    }
  })

  inFlightSummary = task
}

async function generateTaskSummary(
  sessionId: SessionId,
  cacheSafeParams: CacheSafeParams,
): Promise<void> {
  try {
    const result = await runForkedAgent({
      promptMessages: [createUserMessage({ content: TASK_SUMMARY_PROMPT })],
      cacheSafeParams,
      canUseTool: async () => ({
        behavior: 'deny' as const,
        message: 'No tools needed for task summary',
        decisionReason: { type: 'other' as const, reason: 'summary only' },
      }),
      querySource: 'task_summary',
      forkLabel: 'task_summary',
      overrides: {
        agentId: createAgentId('task-summary'),
      },
      maxTurns: 1,
      skipTranscript: true,
      skipCacheWrite: true,
    })

    const summary = extractSummaryText(result.messages)
    if (!summary || summary === lastSummaryText) return

    lastSummaryText = summary
    saveTaskSummary(sessionId as UUID, summary)

    if (getSessionId() === sessionId) {
      notifySessionMetadataChanged({ task_summary: summary })
    }
  } catch (error) {
    logForDebugging(
      `[task-summary] failed to generate task summary: ${error instanceof Error ? error.message : String(error)}`,
      { level: 'error' },
    )
  }
}
