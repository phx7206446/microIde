import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { createChildAbortController } from '../../utils/abortController.js'
import type { QuerySource } from '../../constants/querySource.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { ToolUseContext } from '../../Tool.js'
import type {
  ContextCollapseCommitEntry,
  ContextCollapseSnapshotEntry,
} from '../../types/logs.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import type { Message, StreamEvent } from '../../types/message.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import {
  createUserMessage,
  getAssistantMessageText,
  getLastAssistantMessage,
  getUserMessageText,
} from '../../utils/messages.js'
import {
  recordContextCollapseCommit,
  recordContextCollapseSnapshot,
} from '../../utils/sessionStorage.js'
import { tokenCountWithEstimation } from '../../utils/tokens.js'
import {
  getEffectiveContextWindowSize,
  isAutoCompactEnabled,
} from '../compact/autoCompact.js'
import { groupMessagesByApiRound } from '../compact/grouping.js'
import {
  commitNextStagedCollapse,
  drainAllStagedCollapses,
  getArmed,
  getCollapsedMessageCount,
  getCommittedCollapseCount,
  getLastSpawnTokens,
  getStagedCollapseCount,
  projectView,
  pruneStagedCollapses,
  resetCollapseStore,
  restoreFromEntries as restoreCollapseStoreFromEntries,
  setArmed,
  setLastSpawnTokens,
  snapshotRuntimeState,
  stageCollapseCandidate,
  type RecordedContextCollapseCommit,
} from './operations.js'

type CollapseHealth = {
  totalSpawns: number
  totalErrors: number
  totalEmptySpawns: number
  emptySpawnWarningEmitted: boolean
  lastError: string | null
}

export type ContextCollapseStats = {
  collapsedSpans: number
  collapsedMessages: number
  stagedSpans: number
  health: CollapseHealth
}

type CollapsePlan = {
  startUuid: string
  endUuid: string
  messages: Message[]
  risk: number
}

type CollapseCacheSafePrefix = Pick<
  CacheSafeParams,
  'systemPrompt' | 'userContext' | 'systemContext'
>

const COMMIT_START_RATIO = 0.9
const BLOCKING_SPAWN_RATIO = 0.95
const SPAWN_INTERVAL_TOKENS = 8_000
const EMPTY_SPAWN_WARNING_THRESHOLD = 3
const PRESERVED_TAIL_GROUPS = 4
const MIN_PRESERVED_TAIL_TOKENS = 18_000
const MIN_COLLAPSE_TOKENS = 4_000
const MAX_COLLAPSE_TOKENS = 40_000
const TARGET_COLLAPSE_SHARE = 0.18
const PATH_PATTERN =
  /(?:[A-Za-z]:[\\/][^\s'"<>|]+|(?:src|tests|docs|scripts|app|server|client|config)[\\/][^\s'"<>|]+)/g

const COLLAPSE_SUMMARY_PROMPT = `[CONTEXT COLLAPSE MODE]
Summarize the conversation context already in view so it can replace those exact messages inside the same coding session.

Rules:
- Output plain text only as one compact paragraph.
- Preserve durable facts useful for continuing the task: user goal, concrete files or symbols, commands run, errors seen, decisions made, and unresolved work.
- Mention specific paths, functions, classes, commands, and error strings when they materially matter.
- Do not mention that this is a summary, that messages were collapsed, or refer to "above", "below", or "the transcript".
- Do not use markdown, bullets, XML, or quotes.
- Do not use tools.
- Keep it concise but information-dense.`

const listeners = new Set<() => void>()

const DEFAULT_HEALTH: CollapseHealth = {
  totalSpawns: 0,
  totalErrors: 0,
  totalEmptySpawns: 0,
  emptySpawnWarningEmitted: false,
  lastError: null,
}

let health: CollapseHealth = { ...DEFAULT_HEALTH }
let latestProjectedView: Message[] = []
let spawnInFlight: Promise<boolean> | null = null
let spawnAbortController: AbortController | null = null
let runtimeGeneration = 0
let lastStatsKey = ''

function buildStats(): ContextCollapseStats {
  return {
    collapsedSpans: getCommittedCollapseCount(),
    collapsedMessages: getCollapsedMessageCount(),
    stagedSpans: getStagedCollapseCount(),
    health: { ...health },
  }
}

function makeStatsKey(stats: ContextCollapseStats): string {
  return [
    stats.collapsedSpans,
    stats.collapsedMessages,
    stats.stagedSpans,
    stats.health.totalSpawns,
    stats.health.totalErrors,
    stats.health.totalEmptySpawns,
    stats.health.emptySpawnWarningEmitted ? 1 : 0,
    stats.health.lastError ?? '',
  ].join('|')
}

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

function syncStats(force = false): void {
  const key = makeStatsKey(buildStats())
  if (!force && key === lastStatsKey) {
    return
  }
  lastStatsKey = key
  emit()
}

function canMutateCollapseState(querySource?: QuerySource): boolean {
  return (
    querySource === undefined ||
    querySource.startsWith('repl_main_thread') ||
    querySource === 'sdk'
  )
}

function isInternalCollapseSource(querySource?: QuerySource): boolean {
  return (
    querySource === 'compact' ||
    querySource === 'session_memory' ||
    querySource === 'marble_origami'
  )
}

function ownsAutomaticCollapseFlow(querySource?: QuerySource): boolean {
  return (
    isContextCollapseEnabled() &&
    isAutoCompactEnabled() &&
    canMutateCollapseState(querySource) &&
    !isInternalCollapseSource(querySource)
  )
}

function rememberLatestView(view: Message[], querySource?: QuerySource): void {
  if (!canMutateCollapseState(querySource)) {
    return
  }
  latestProjectedView = view
}

function abortSpawn(reason: string): void {
  runtimeGeneration += 1
  spawnAbortController?.abort(reason)
  spawnAbortController = null
  spawnInFlight = null
}

function resetHealth(): void {
  health = { ...DEFAULT_HEALTH }
}

async function persistSnapshot(querySource?: QuerySource): Promise<void> {
  if (!canMutateCollapseState(querySource)) {
    return
  }
  try {
    await recordContextCollapseSnapshot(snapshotRuntimeState())
  } catch (error) {
    logError(error)
  }
}

async function persistCommits(
  commits: readonly RecordedContextCollapseCommit[],
  querySource?: QuerySource,
): Promise<void> {
  if (!canMutateCollapseState(querySource) || commits.length === 0) {
    return
  }
  try {
    for (const commit of commits) {
      await recordContextCollapseCommit(commit)
    }
  } catch (error) {
    logError(error)
  }
}

async function persistCommitsAndSnapshot(
  commits: readonly RecordedContextCollapseCommit[],
  querySource?: QuerySource,
): Promise<void> {
  await persistCommits(commits, querySource)
  await persistSnapshot(querySource)
}

function getCommitThreshold(model: string): number {
  return Math.floor(getEffectiveContextWindowSize(model) * COMMIT_START_RATIO)
}

function getBlockingSpawnThreshold(model: string): number {
  return Math.floor(
    getEffectiveContextWindowSize(model) * BLOCKING_SPAWN_RATIO,
  )
}

async function reconcileTriggerState(
  tokenUsage: number,
  threshold: number,
  querySource?: QuerySource,
): Promise<void> {
  let changed = false

  if (tokenUsage < threshold) {
    changed = setArmed(false) || changed
    changed = setLastSpawnTokens(0) || changed
  } else {
    changed = setArmed(true) || changed
  }

  if (changed) {
    await persistSnapshot(querySource)
    syncStats()
  }
}

async function commitStagedToThreshold(
  view: Message[],
  threshold: number,
  querySource?: QuerySource,
): Promise<Message[]> {
  const commits: RecordedContextCollapseCommit[] = []
  let nextView = view

  while (tokenCountWithEstimation(nextView) >= threshold) {
    const next = commitNextStagedCollapse(nextView)
    nextView = next.messages
    if (!next.commit) {
      break
    }
    commits.push(next.commit)
  }

  if (commits.length > 0) {
    rememberLatestView(nextView, querySource)
    await persistCommitsAndSnapshot(commits, querySource)
    syncStats()
  }

  return nextView
}

function getMessageUuid(message: Message | undefined): string | null {
  if (!message || !('uuid' in message) || typeof message.uuid !== 'string') {
    return null
  }
  return message.uuid
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function estimateGroupTokens(group: readonly Message[]): number {
  return tokenCountWithEstimation([...group])
}

function chooseCollapsePlan(
  view: readonly Message[],
  model: string,
): CollapsePlan | null {
  const groups = groupMessagesByApiRound([...view])
  if (groups.length <= PRESERVED_TAIL_GROUPS) {
    return null
  }

  const groupTokens = groups.map(group => estimateGroupTokens(group))
  const effectiveWindow = getEffectiveContextWindowSize(model)
  const targetSpanTokens = clamp(
    Math.floor(effectiveWindow * TARGET_COLLAPSE_SHARE),
    MIN_COLLAPSE_TOKENS,
    MAX_COLLAPSE_TOKENS,
  )

  let tailStart = Math.max(1, groups.length - PRESERVED_TAIL_GROUPS)
  let tailTokens = groupTokens
    .slice(tailStart)
    .reduce((total, value) => total + value, 0)

  while (tailStart > 1 && tailTokens < MIN_PRESERVED_TAIL_TOKENS) {
    tailStart -= 1
    tailTokens += groupTokens[tailStart] ?? 0
  }

  const maxCollapsedGroupIndex = tailStart - 1
  if (maxCollapsedGroupIndex < 0) {
    return null
  }

  let collapsedTokens = 0
  let endGroupIndex = -1
  for (let index = 0; index <= maxCollapsedGroupIndex; index++) {
    collapsedTokens += groupTokens[index] ?? 0
    endGroupIndex = index
    if (collapsedTokens >= targetSpanTokens) {
      break
    }
  }

  if (endGroupIndex < 0 || collapsedTokens < MIN_COLLAPSE_TOKENS) {
    return null
  }

  const startUuid = getMessageUuid(groups[0]?.[0])
  const endUuid = getMessageUuid(groups[endGroupIndex]?.at(-1))
  if (!startUuid || !endUuid) {
    return null
  }

  const summaryMessages = groups.slice(0, endGroupIndex + 1).flat()
  if (summaryMessages.length < 2) {
    return null
  }

  const totalTokens = Math.max(1, tokenCountWithEstimation([...view]))
  return {
    startUuid,
    endUuid,
    messages: summaryMessages,
    risk: Math.min(1, collapsedTokens / totalTokens),
  }
}

function normalizeSummary(summary: string | null | undefined): string | null {
  if (!summary) {
    return null
  }
  const normalized = summary
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
  return normalized || null
}

function truncateLine(value: string, maxLength = 220): string {
  if (value.length <= maxLength) {
    return value
  }
  return `${value.slice(0, maxLength - 3).trimEnd()}...`
}

function extractObjective(messages: readonly Message[]): string | null {
  for (const message of messages) {
    if (message.type !== 'user' || message.isMeta) {
      continue
    }
    const text = normalizeSummary(getUserMessageText(message))
    if (!text) {
      continue
    }
    if (Array.isArray(message.message.content)) {
      const isToolResultOnly =
        message.message.content.length > 0 &&
        message.message.content.every(block => block.type === 'tool_result')
      if (isToolResultOnly) {
        continue
      }
    }
    return truncateLine(text)
  }
  return null
}

function extractRecentFocus(messages: readonly Message[]): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!message) {
      continue
    }

    if (message.type === 'assistant') {
      const text = normalizeSummary(getAssistantMessageText(message))
      if (text) {
        return truncateLine(text)
      }
      continue
    }

    if (message.type === 'user') {
      const text = normalizeSummary(getUserMessageText(message))
      if (text) {
        return truncateLine(text)
      }
    }
  }

  return null
}

function extractFileRefs(messages: readonly Message[]): string[] {
  const seen = new Set<string>()
  const refs: string[] = []

  for (const message of messages) {
    let rendered = ''
    if (message.type === 'assistant') {
      rendered = getAssistantMessageText(message) ?? ''
    } else if (message.type === 'user') {
      rendered = getUserMessageText(message) ?? ''
    } else if (message.type === 'system') {
      rendered = message.content ?? ''
    }

    for (const match of rendered.matchAll(PATH_PATTERN)) {
      const normalized = match[0].replace(/\\/g, '/')
      if (seen.has(normalized)) {
        continue
      }
      seen.add(normalized)
      refs.push(normalized)
    }
  }

  return refs
}

function collectToolNames(messages: readonly Message[]): string[] {
  const seen = new Set<string>()
  const tools: string[] = []

  for (const message of messages) {
    if (message.type !== 'assistant') {
      continue
    }
    for (const block of message.message.content) {
      if (block.type !== 'tool_use' || !block.name || seen.has(block.name)) {
        continue
      }
      seen.add(block.name)
      tools.push(block.name)
    }
  }

  return tools
}

function buildFallbackSummary(messages: readonly Message[]): string | null {
  const parts: string[] = []

  const objective = extractObjective(messages)
  if (objective) {
    parts.push(`Goal: ${objective}`)
  }

  const focus = extractRecentFocus(messages)
  if (focus) {
    parts.push(`Recent focus: ${focus}`)
  }

  const fileRefs = extractFileRefs(messages)
  if (fileRefs.length > 0) {
    parts.push(`Files: ${fileRefs.slice(0, 6).join(', ')}`)
  }

  const tools = collectToolNames(messages)
  if (tools.length > 0) {
    parts.push(`Tools: ${tools.slice(0, 6).join(', ')}`)
  }

  return normalizeSummary(parts.join('. '))
}

function getSpawnSummary(resultMessages: readonly Message[]): string | null {
  const assistant = getLastAssistantMessage([...resultMessages])
  if (!assistant) {
    return null
  }
  if (assistant.isApiErrorMessage) {
    throw new Error(
      assistant.errorDetails ??
        getAssistantMessageText(assistant) ??
        'context collapse summarizer failed',
    )
  }

  return normalizeSummary(getAssistantMessageText(assistant))
}

function getCollapseCanUseTool(): CanUseToolFn {
  return async () => ({
    behavior: 'deny' as const,
    message: 'No tools needed for context collapse summarization',
    decisionReason: {
      type: 'other' as const,
      reason: 'context collapse summary only',
    },
  })
}

async function runCollapseSpawn(
  plan: CollapsePlan,
  toolUseContext: ToolUseContext,
  cacheSafePrefix: CollapseCacheSafePrefix,
  querySource: QuerySource | undefined,
  generation: number,
  controller: AbortController,
): Promise<boolean> {
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { runForkedAgent } =
      require('../../utils/forkedAgent.js') as typeof import('../../utils/forkedAgent.js')
    /* eslint-enable @typescript-eslint/no-require-imports */

    const result = await runForkedAgent({
      promptMessages: [createUserMessage({ content: COLLAPSE_SUMMARY_PROMPT })],
      cacheSafeParams: {
        ...cacheSafePrefix,
        toolUseContext,
        forkContextMessages: plan.messages,
      },
      canUseTool: getCollapseCanUseTool(),
      querySource: 'marble_origami',
      forkLabel: 'marble_origami',
      maxTurns: 1,
      skipTranscript: true,
      skipCacheWrite: true,
      overrides: {
        abortController: controller,
      },
    })

    if (generation !== runtimeGeneration) {
      return false
    }

    const summary =
      getSpawnSummary(result.messages) ?? buildFallbackSummary(plan.messages)
    const liveView =
      latestProjectedView.length > 0
        ? latestProjectedView
        : projectView([...plan.messages])
    const staged =
      summary !== null &&
      stageCollapseCandidate(
        {
          startUuid: plan.startUuid,
          endUuid: plan.endUuid,
          summary,
          risk: plan.risk,
        },
        liveView,
      ) !== null

    if (staged) {
      health.totalEmptySpawns = 0
      health.emptySpawnWarningEmitted = false
    } else {
      health.totalEmptySpawns += 1
      if (health.totalEmptySpawns >= EMPTY_SPAWN_WARNING_THRESHOLD) {
        health.emptySpawnWarningEmitted = true
      }
    }

    await persistSnapshot(querySource)
    syncStats()
    return staged
  } catch (error) {
    if (generation === runtimeGeneration) {
      health.totalErrors += 1
      health.lastError =
        error instanceof Error ? error.message : String(error ?? 'unknown error')
      syncStats()
      logError(error)
    }
    return false
  }
}

async function maybeStartSpawn(
  view: Message[],
  toolUseContext: ToolUseContext,
  cacheSafePrefix: CollapseCacheSafePrefix | undefined,
  querySource: QuerySource | undefined,
  tokenUsage: number,
  force: boolean,
): Promise<boolean> {
  if (spawnInFlight) {
    return force ? await spawnInFlight : false
  }

  if (!force && getStagedCollapseCount() > 0) {
    return false
  }
  if (!cacheSafePrefix) {
    return false
  }

  const plan = chooseCollapsePlan(view, toolUseContext.options.mainLoopModel)
  if (!plan) {
    return false
  }

  setArmed(true)
  setLastSpawnTokens(tokenUsage)
  await persistSnapshot(querySource)

  health.totalSpawns += 1
  syncStats()

  const generation = runtimeGeneration
  const controller = createChildAbortController(toolUseContext.abortController)
  spawnAbortController = controller

  const task = runCollapseSpawn(
    plan,
    toolUseContext,
    cacheSafePrefix,
    querySource,
    generation,
    controller,
  ).finally(() => {
    if (spawnAbortController === controller) {
      spawnAbortController = null
    }
    if (spawnInFlight === task) {
      spawnInFlight = null
    }
  })

  spawnInFlight = task

  if (force) {
    return await task
  }

  return true
}

function shouldStartBackgroundSpawn(
  tokenUsage: number,
  wasArmed: boolean,
): boolean {
  if (spawnInFlight || getStagedCollapseCount() > 0) {
    return false
  }
  if (!wasArmed) {
    return true
  }
  const lastSpawnTokens = getLastSpawnTokens()
  return (
    lastSpawnTokens === 0 ||
    tokenUsage >= lastSpawnTokens + SPAWN_INTERVAL_TOKENS
  )
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getStats(): ContextCollapseStats {
  return buildStats()
}

export function initContextCollapse(): void {
  abortSpawn('init')
  resetCollapseStore()
  resetHealth()
  latestProjectedView = []
  syncStats(true)
}

export function isContextCollapseEnabled(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CONTEXT_COLLAPSE)
}

export function isWithheldPromptTooLong(
  message: Message | StreamEvent | undefined,
  isPromptTooLongMessage: (message: Message) => boolean,
  querySource: QuerySource,
): boolean {
  if (!ownsAutomaticCollapseFlow(querySource)) {
    return false
  }
  if (!message || message.type !== 'assistant' || !message.isApiErrorMessage) {
    return false
  }
  return isPromptTooLongMessage(message)
}

export async function applyCollapsesIfNeeded<T extends Message>(
  messages: T[],
  toolUseContext?: ToolUseContext,
  querySource?: QuerySource,
  cacheSafePrefix?: CollapseCacheSafePrefix,
): Promise<{ messages: T[] }> {
  let view = projectView(messages as Message[])
  rememberLatestView(view, querySource)

  const pruned = pruneStagedCollapses(view)
  if (pruned) {
    await persistSnapshot(querySource)
    syncStats()
  } else {
    syncStats()
  }

  if (!toolUseContext || !ownsAutomaticCollapseFlow(querySource)) {
    return { messages: view as T[] }
  }

  const model = toolUseContext.options.mainLoopModel
  const commitThreshold = getCommitThreshold(model)
  const blockingThreshold = getBlockingSpawnThreshold(model)

  let tokenUsage = tokenCountWithEstimation(view)
  const wasArmed = getArmed()
  await reconcileTriggerState(tokenUsage, commitThreshold, querySource)

  if (tokenUsage >= commitThreshold) {
    view = await commitStagedToThreshold(view, commitThreshold, querySource)
    rememberLatestView(view, querySource)
    tokenUsage = tokenCountWithEstimation(view)
  }

  if (
    tokenUsage >= commitThreshold &&
    shouldStartBackgroundSpawn(tokenUsage, wasArmed)
  ) {
    void maybeStartSpawn(
      view,
      toolUseContext,
      cacheSafePrefix,
      querySource,
      tokenUsage,
      false,
    )
  }

  if (tokenUsage >= blockingThreshold) {
    logForDebugging(
      `[context-collapse] entering blocking spawn at ${tokenUsage} tokens`,
    )

    await maybeStartSpawn(
      view,
      toolUseContext,
      cacheSafePrefix,
      querySource,
      tokenUsage,
      true,
    )
    view = await commitStagedToThreshold(view, commitThreshold, querySource)
    rememberLatestView(view, querySource)
    tokenUsage = tokenCountWithEstimation(view)
    await reconcileTriggerState(tokenUsage, commitThreshold, querySource)
  }

  return { messages: view as T[] }
}

export function recoverFromOverflow<T extends Message>(
  messages: T[],
  querySource?: QuerySource,
): { messages: T[]; committed: number } {
  const view = projectView(messages as Message[])
  rememberLatestView(view, querySource)
  syncStats()

  if (!ownsAutomaticCollapseFlow(querySource)) {
    return {
      messages: view as T[],
      committed: 0,
    }
  }

  const drained = drainAllStagedCollapses(view)
  rememberLatestView(drained.messages, querySource)

  if (drained.commits.length > 0) {
    void persistCommitsAndSnapshot(drained.commits, querySource)
  } else {
    void persistSnapshot(querySource)
  }

  void reconcileTriggerState(
    tokenCountWithEstimation(drained.messages),
    Number.POSITIVE_INFINITY,
    querySource,
  )
  syncStats()

  return {
    messages: drained.messages as T[],
    committed: drained.commits.length,
  }
}

export function restorePersistedContextCollapse(
  commits: ContextCollapseCommitEntry[],
  snapshot?: ContextCollapseSnapshotEntry,
): void {
  abortSpawn('restore')
  resetHealth()
  latestProjectedView = []
  restoreCollapseStoreFromEntries(commits, snapshot)
  syncStats(true)
}

export function resetContextCollapse(): void {
  abortSpawn('reset')
  resetCollapseStore()
  resetHealth()
  latestProjectedView = []
  syncStats(true)
}
