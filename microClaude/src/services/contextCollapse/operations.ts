import { randomUUID } from 'crypto'
import type {
  ContextCollapseCommitEntry,
  ContextCollapseSnapshotEntry,
} from '../../types/logs.js'
import type { Message, UserMessage } from '../../types/message.js'
import { createUserMessage } from '../../utils/messages.js'

export type RecordedContextCollapseCommit = Omit<
  ContextCollapseCommitEntry,
  'type' | 'sessionId'
>

type RuntimeCollapseBase = {
  collapseId: string
  summaryUuid: string
  summaryContent: string
  summary: string
}

type CommittedCollapse = RuntimeCollapseBase & {
  firstArchivedUuid: string
  lastArchivedUuid: string
  archivedMessageCount?: number
}

export type StagedCollapse = RuntimeCollapseBase & {
  startUuid: string
  endUuid: string
  risk: number
  stagedAt: number
}

type ResolvedSpan = {
  startIndex: number
  endIndex: number
}

const COLLAPSE_ID_BASE = 1_000_000_000_000_000n
const MAX_SUMMARY_CHARS = 1_200
const MIN_SPAN_MESSAGES = 2

let committedCollapses: CommittedCollapse[] = []
let stagedCollapses: StagedCollapse[] = []
let nextCollapseId = COLLAPSE_ID_BASE
let armed = false
let lastSpawnTokens = 0

function normalizeSummary(summary: string): string {
  const collapsed = summary.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= MAX_SUMMARY_CHARS) {
    return collapsed
  }
  return collapsed.slice(0, MAX_SUMMARY_CHARS - 3).trimEnd() + '...'
}

function escapeCollapsedText(summary: string): string {
  return summary
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function formatCollapseId(value: bigint): string {
  return value.toString().padStart(16, '0')
}

function parseCollapseId(value: string): bigint | null {
  if (!/^\d{1,32}$/.test(value)) {
    return null
  }
  try {
    return BigInt(value)
  } catch {
    return null
  }
}

function reseedCounterFromCommitted(): void {
  let maxId = COLLAPSE_ID_BASE - 1n
  for (const collapse of committedCollapses) {
    const parsed = parseCollapseId(collapse.collapseId)
    if (parsed !== null && parsed > maxId) {
      maxId = parsed
    }
  }
  nextCollapseId = maxId >= COLLAPSE_ID_BASE ? maxId + 1n : COLLAPSE_ID_BASE
}

function allocateRuntimeSummary(summary: string): RuntimeCollapseBase {
  const normalized = normalizeSummary(summary)
  const collapseId = formatCollapseId(nextCollapseId)
  nextCollapseId += 1n
  return {
    collapseId,
    summaryUuid: randomUUID(),
    summaryContent: `<collapsed id="${collapseId}">${escapeCollapsedText(normalized)}</collapsed>`,
    summary: normalized,
  }
}

function createCollapsedMessage(
  collapse: RuntimeCollapseBase,
  timestamp?: string,
): UserMessage {
  return createUserMessage({
    content: collapse.summaryContent,
    isMeta: true,
    uuid: collapse.summaryUuid,
    timestamp,
  })
}

function resolveSpan(
  messages: readonly Message[],
  startUuid: string,
  endUuid: string,
): ResolvedSpan | null {
  let startIndex = -1
  let endIndex = -1

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (!message || !('uuid' in message) || typeof message.uuid !== 'string') {
      continue
    }
    if (startIndex === -1 && message.uuid === startUuid) {
      startIndex = i
    }
    if (message.uuid === endUuid) {
      endIndex = i
      if (startIndex !== -1) {
        break
      }
    }
  }

  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    return null
  }
  if (endIndex - startIndex + 1 < MIN_SPAN_MESSAGES) {
    return null
  }
  return { startIndex, endIndex }
}

function replaceSpanWithSummary(
  messages: readonly Message[],
  span: ResolvedSpan,
  collapse: RuntimeCollapseBase,
): Message[] {
  const firstMessage = messages[span.startIndex]
  const timestamp =
    firstMessage && 'timestamp' in firstMessage
      ? firstMessage.timestamp
      : undefined
  return [
    ...messages.slice(0, span.startIndex),
    createCollapsedMessage(collapse, timestamp),
    ...messages.slice(span.endIndex + 1),
  ]
}

function getCommittedBySummaryUuid(uuid: string): CommittedCollapse | undefined {
  return committedCollapses.find(collapse => collapse.summaryUuid === uuid)
}

function countArchivedMessages(messages: readonly Message[]): number {
  let total = 0
  for (const message of messages) {
    if (!('uuid' in message) || typeof message.uuid !== 'string') {
      continue
    }
    const prior = getCommittedBySummaryUuid(message.uuid)
    if (prior?.archivedMessageCount !== undefined) {
      total += prior.archivedMessageCount
    } else {
      total += 1
    }
  }
  return total
}

function applyCommittedCollapse(
  messages: readonly Message[],
  collapse: CommittedCollapse,
): { messages: Message[]; archived: Message[] } | null {
  const span = resolveSpan(
    messages,
    collapse.firstArchivedUuid,
    collapse.lastArchivedUuid,
  )
  if (!span) {
    return null
  }

  const archived = messages.slice(span.startIndex, span.endIndex + 1)
  if (collapse.archivedMessageCount === undefined) {
    collapse.archivedMessageCount = countArchivedMessages(archived)
  }

  return {
    messages: replaceSpanWithSummary(messages, span, collapse),
    archived,
  }
}

function runtimeToCommitEntry(
  collapse: CommittedCollapse,
): RecordedContextCollapseCommit {
  return {
    collapseId: collapse.collapseId,
    summaryUuid: collapse.summaryUuid,
    summaryContent: collapse.summaryContent,
    summary: collapse.summary,
    firstArchivedUuid: collapse.firstArchivedUuid,
    lastArchivedUuid: collapse.lastArchivedUuid,
  }
}

function sortStaged(messages: readonly Message[]): void {
  stagedCollapses.sort((left, right) => {
    const leftSpan = resolveSpan(messages, left.startUuid, left.endUuid)
    const rightSpan = resolveSpan(messages, right.startUuid, right.endUuid)

    if (leftSpan && rightSpan) {
      if (leftSpan.startIndex !== rightSpan.startIndex) {
        return leftSpan.startIndex - rightSpan.startIndex
      }
      if (left.risk !== right.risk) {
        return left.risk - right.risk
      }
      return left.stagedAt - right.stagedAt
    }
    if (leftSpan) return -1
    if (rightSpan) return 1
    return left.stagedAt - right.stagedAt
  })
}

export function projectView(messages: Message[]): Message[] {
  if (committedCollapses.length === 0) {
    return messages
  }

  let projected = [...messages]
  for (const collapse of committedCollapses) {
    const applied = applyCommittedCollapse(projected, collapse)
    if (!applied) {
      continue
    }
    projected = applied.messages
  }
  return projected
}

export function getCommittedCollapseCount(): number {
  return committedCollapses.length
}

export function getCollapsedMessageCount(): number {
  return committedCollapses.reduce(
    (total, collapse) => total + (collapse.archivedMessageCount ?? 0),
    0,
  )
}

export function getStagedCollapseCount(): number {
  return stagedCollapses.length
}

export function getStagedCollapses(): readonly StagedCollapse[] {
  return stagedCollapses
}

export function getArmed(): boolean {
  return armed
}

export function setArmed(next: boolean): boolean {
  if (armed === next) {
    return false
  }
  armed = next
  return true
}

export function getLastSpawnTokens(): number {
  return lastSpawnTokens
}

export function setLastSpawnTokens(next: number): boolean {
  if (lastSpawnTokens === next) {
    return false
  }
  lastSpawnTokens = next
  return true
}

export function stageCollapseCandidate(
  candidate: {
    startUuid: string
    endUuid: string
    summary: string
    risk: number
    stagedAt?: number
  },
  messages: readonly Message[],
): StagedCollapse | null {
  const summary = normalizeSummary(candidate.summary)
  if (!summary) {
    return null
  }

  const span = resolveSpan(messages, candidate.startUuid, candidate.endUuid)
  if (!span) {
    return null
  }

  if (
    committedCollapses.some(
      collapse =>
        collapse.firstArchivedUuid === candidate.startUuid &&
        collapse.lastArchivedUuid === candidate.endUuid,
    )
  ) {
    return null
  }

  if (
    stagedCollapses.some(
      collapse =>
        collapse.startUuid === candidate.startUuid &&
        collapse.endUuid === candidate.endUuid,
    )
  ) {
    return null
  }

  const runtime = allocateRuntimeSummary(summary)
  const staged: StagedCollapse = {
    ...runtime,
    startUuid: candidate.startUuid,
    endUuid: candidate.endUuid,
    risk: Math.max(0, Math.min(1, candidate.risk)),
    stagedAt: candidate.stagedAt ?? Date.now(),
  }
  stagedCollapses.push(staged)
  sortStaged(messages)
  return staged
}

export function pruneStagedCollapses(messages: readonly Message[]): boolean {
  if (stagedCollapses.length === 0) {
    return false
  }

  const seen = new Set<string>()
  const committedKeys = new Set(
    committedCollapses.map(
      collapse => `${collapse.firstArchivedUuid}|${collapse.lastArchivedUuid}`,
    ),
  )
  const next: StagedCollapse[] = []

  for (const collapse of stagedCollapses) {
    const key = `${collapse.startUuid}|${collapse.endUuid}`
    if (seen.has(key) || committedKeys.has(key)) {
      continue
    }
    if (!resolveSpan(messages, collapse.startUuid, collapse.endUuid)) {
      continue
    }
    seen.add(key)
    next.push(collapse)
  }

  const changed = next.length !== stagedCollapses.length
  stagedCollapses = next
  sortStaged(messages)
  return changed
}

export function commitNextStagedCollapse(messages: Message[]): {
  messages: Message[]
  commit: RecordedContextCollapseCommit | null
} {
  let view = projectView(messages)
  if (stagedCollapses.length === 0) {
    return { messages: view, commit: null }
  }

  sortStaged(view)

  const stageIndex = stagedCollapses.findIndex(collapse =>
    resolveSpan(view, collapse.startUuid, collapse.endUuid),
  )
  if (stageIndex === -1) {
    pruneStagedCollapses(view)
    return { messages: view, commit: null }
  }

  const [staged] = stagedCollapses.splice(stageIndex, 1)
  if (!staged) {
    return { messages: view, commit: null }
  }

  const span = resolveSpan(view, staged.startUuid, staged.endUuid)
  if (!span) {
    pruneStagedCollapses(view)
    return { messages: view, commit: null }
  }

  const archived = view.slice(span.startIndex, span.endIndex + 1)
  const committed: CommittedCollapse = {
    ...staged,
    firstArchivedUuid: staged.startUuid,
    lastArchivedUuid: staged.endUuid,
    archivedMessageCount: countArchivedMessages(archived),
  }
  committedCollapses.push(committed)
  view = replaceSpanWithSummary(view, span, committed)
  pruneStagedCollapses(view)

  return {
    messages: view,
    commit: runtimeToCommitEntry(committed),
  }
}

export function drainAllStagedCollapses(messages: Message[]): {
  messages: Message[]
  commits: RecordedContextCollapseCommit[]
} {
  let view = projectView(messages)
  const commits: RecordedContextCollapseCommit[] = []

  while (stagedCollapses.length > 0) {
    const next = commitNextStagedCollapse(view)
    view = next.messages
    if (!next.commit) {
      break
    }
    commits.push(next.commit)
  }

  return { messages: view, commits }
}

export function snapshotRuntimeState(): Pick<
  ContextCollapseSnapshotEntry,
  'staged' | 'armed' | 'lastSpawnTokens'
> {
  return {
    staged: stagedCollapses.map(collapse => ({
      startUuid: collapse.startUuid,
      endUuid: collapse.endUuid,
      summary: collapse.summary,
      risk: collapse.risk,
      stagedAt: collapse.stagedAt,
    })),
    armed,
    lastSpawnTokens,
  }
}

export function resetCollapseStore(): void {
  committedCollapses = []
  stagedCollapses = []
  nextCollapseId = COLLAPSE_ID_BASE
  armed = false
  lastSpawnTokens = 0
}

export function restoreFromEntries(
  commits: ContextCollapseCommitEntry[],
  snapshot?: ContextCollapseSnapshotEntry,
): void {
  resetCollapseStore()

  committedCollapses = commits.map(entry => ({
    collapseId: entry.collapseId,
    summaryUuid: entry.summaryUuid,
    summaryContent: entry.summaryContent,
    summary: normalizeSummary(entry.summary),
    firstArchivedUuid: entry.firstArchivedUuid,
    lastArchivedUuid: entry.lastArchivedUuid,
  }))

  reseedCounterFromCommitted()

  if (snapshot) {
    stagedCollapses = snapshot.staged
      .map(entry => {
        const runtime = allocateRuntimeSummary(entry.summary)
        return {
          ...runtime,
          startUuid: entry.startUuid,
          endUuid: entry.endUuid,
          risk: Math.max(0, Math.min(1, entry.risk)),
          stagedAt: entry.stagedAt,
        }
      })
      .filter(collapse => collapse.summary.length > 0)
    armed = snapshot.armed
    lastSpawnTokens = snapshot.lastSpawnTokens
  }
}
