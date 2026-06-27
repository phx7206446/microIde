import { appendFile, mkdir, readFile, stat, writeFile } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { getKairosActive, getSessionId } from '../../bootstrap/state.js'
import { getAutoMemPath, isAutoMemoryEnabled } from '../../memdir/paths.js'
import type { Message } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  getAssistantMessageText,
  getUserMessageText,
  isThinkingMessage,
} from '../../utils/messages.js'

type DateParts = {
  key: string
  yyyy: string
  mm: string
  dd: string
}

type RenderedEntry = {
  uuid: string
  timestampMs: number
  batchTimeLabel: string
  line: string
}

type SeenState = {
  version: 1
  seenMessageUuids: string[]
}

const ENTRY_TEXT_LIMIT = 700
const TOOL_NAME_LIMIT = 4
const STATE_VERSION = 1

let writeQueue: Promise<void> = Promise.resolve()

function enqueueWrite(work: () => Promise<void>): Promise<void> {
  const next = writeQueue.catch(() => undefined).then(async () => {
    try {
      await work()
    } catch (error) {
      logForDebugging(
        `[sessionTranscript] write failed: ${error instanceof Error ? error.message : String(error)}`,
        { level: 'error' },
      )
    }
  })
  writeQueue = next
  return next
}

function shouldWriteSessionTranscript(): boolean {
  return getKairosActive() && isAutoMemoryEnabled()
}

function normalizeInline(text: string, maxLength = ENTRY_TEXT_LIMIT): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) {
    return normalized
  }
  return `${normalized.slice(0, maxLength - 1).trimEnd()}...`
}

function formatTimeLabel(date: Date): string {
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  })
}

function getDateParts(date: Date): DateParts {
  const yyyy = date.getFullYear().toString()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return {
    key: `${yyyy}-${mm}-${dd}`,
    yyyy,
    mm,
    dd,
  }
}

function parseTimestampParts(timestamp: string): { date: Date; parts: DateParts } | null {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) {
    return null
  }
  return { date, parts: getDateParts(date) }
}

function hasTimestamp(
  message: Message,
): message is Exclude<Message, { type: 'stream_request_start' }> & {
  timestamp: string
} {
  return 'timestamp' in message && typeof message.timestamp === 'string'
}

function summarizeToolNames(message: Extract<Message, { type: 'assistant' }>): string | null {
  if (!Array.isArray(message.message.content)) {
    return null
  }

  const toolNames = message.message.content
    .filter(
      (
        block,
      ): block is Extract<(typeof message.message.content)[number], { type: 'tool_use' }> =>
        block.type === 'tool_use',
    )
    .map(block => block.name)

  if (toolNames.length === 0) {
    return null
  }

  const uniqueToolNames = [...new Set(toolNames)]
  if (uniqueToolNames.length <= TOOL_NAME_LIMIT) {
    return uniqueToolNames.join(', ')
  }

  const visible = uniqueToolNames.slice(0, TOOL_NAME_LIMIT).join(', ')
  return `${visible}, +${uniqueToolNames.length - TOOL_NAME_LIMIT} more`
}

function renderSystemMessage(message: Extract<Message, { type: 'system' }>): string | null {
  switch (message.subtype) {
    case 'local_command':
      return message.content
        ? `Local command: ${normalizeInline(message.content)}`
        : null
    case 'memory_saved':
      return message.writtenPaths.length > 0
        ? `Memory updated: ${message.writtenPaths
            .map(filePath => basename(filePath))
            .join(', ')}`
        : 'Memory updated'
    case 'away_summary':
    case 'scheduled_task_fire':
    case 'informational':
    case 'permission_retry':
      return message.content ? normalizeInline(message.content) : null
    case 'bridge_status':
      return normalizeInline(
        message.upgradeNudge
          ? `${message.content} ${message.upgradeNudge}`
          : message.content,
      )
    case 'stop_hook_summary': {
      const parts: string[] = []
      if (message.hookErrors.length > 0) {
        parts.push(
          `errors: ${normalizeInline(message.hookErrors.join(' | '), 300)}`,
        )
      }
      if (message.preventedContinuation) {
        parts.push('continuation prevented')
      }
      if (message.stopReason) {
        parts.push(`reason: ${normalizeInline(message.stopReason, 200)}`)
      }
      if (parts.length === 0) {
        return null
      }
      return `Stop hooks: ${parts.join('; ')}`
    }
    case 'api_error':
      return `API error: ${normalizeInline(message.error.message)}`
    default:
      return null
  }
}

function renderMessage(message: Message): { line: string; timestampMs: number } | null {
  if (
    !('uuid' in message) ||
    typeof message.uuid !== 'string' ||
    !hasTimestamp(message)
  ) {
    return null
  }

  const parsed = parseTimestampParts(message.timestamp)
  if (parsed === null) {
    return null
  }

  const timeLabel = formatTimeLabel(parsed.date)

  switch (message.type) {
    case 'user': {
      const text = getUserMessageText(message)
      if (!text) {
        return null
      }
      return {
        timestampMs: parsed.date.getTime(),
        line: `- ${timeLabel} User: ${normalizeInline(text)}`,
      }
    }
    case 'assistant': {
      if (isThinkingMessage(message)) {
        return null
      }
      const text = getAssistantMessageText(message)
      const toolSummary = summarizeToolNames(message)
      if (text && toolSummary) {
        return {
          timestampMs: parsed.date.getTime(),
          line: `- ${timeLabel} Claude: ${normalizeInline(text)} [tools: ${toolSummary}]`,
        }
      }
      if (text) {
        return {
          timestampMs: parsed.date.getTime(),
          line: `- ${timeLabel} Claude: ${normalizeInline(text)}`,
        }
      }
      if (toolSummary) {
        return {
          timestampMs: parsed.date.getTime(),
          line: `- ${timeLabel} Claude used: ${toolSummary}`,
        }
      }
      if (message.errorDetails) {
        return {
          timestampMs: parsed.date.getTime(),
          line: `- ${timeLabel} Claude error: ${normalizeInline(message.errorDetails)}`,
        }
      }
      return null
    }
    case 'system': {
      const rendered = renderSystemMessage(message)
      if (!rendered) {
        return null
      }
      return {
        timestampMs: parsed.date.getTime(),
        line: `- ${timeLabel} ${rendered}`,
      }
    }
    case 'tool_use_summary':
      return {
        timestampMs: parsed.date.getTime(),
        line: `- ${timeLabel} Tool summary: ${normalizeInline(message.summary, 300)}`,
      }
    default:
      return null
  }
}

function getTranscriptPath(parts: DateParts): string {
  return join(
    getAutoMemPath(),
    'sessions',
    parts.yyyy,
    parts.mm,
    `${parts.key}.md`,
  )
}

function getStatePath(parts: DateParts): string {
  return join(
    getAutoMemPath(),
    '.session-transcript-state',
    parts.yyyy,
    parts.mm,
    `${parts.key}.json`,
  )
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function loadSeenState(parts: DateParts): Promise<SeenState> {
  try {
    const raw = await readFile(getStatePath(parts), 'utf8')
    const parsed = JSON.parse(raw) as Partial<SeenState>
    if (
      parsed.version !== STATE_VERSION ||
      !Array.isArray(parsed.seenMessageUuids)
    ) {
      return { version: STATE_VERSION, seenMessageUuids: [] }
    }
    return {
      version: STATE_VERSION,
      seenMessageUuids: parsed.seenMessageUuids.filter(
        (value): value is string => typeof value === 'string',
      ),
    }
  } catch {
    return { version: STATE_VERSION, seenMessageUuids: [] }
  }
}

async function saveSeenState(parts: DateParts, state: SeenState): Promise<void> {
  const statePath = getStatePath(parts)
  await mkdir(dirname(statePath), { recursive: true })
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

function buildRenderedBuckets(messages: Message[]): Map<string, { parts: DateParts; entries: RenderedEntry[] }> {
  const buckets = new Map<string, { parts: DateParts; entries: RenderedEntry[] }>()

  for (const message of messages) {
    if (
      !('uuid' in message) ||
      typeof message.uuid !== 'string' ||
      !hasTimestamp(message)
    ) {
      continue
    }

    const parsed = parseTimestampParts(message.timestamp)
    if (parsed === null) {
      continue
    }

    const rendered = renderMessage(message)
    if (rendered === null) {
      continue
    }

    const bucket =
      buckets.get(parsed.parts.key) ??
      (() => {
        const initial = { parts: parsed.parts, entries: [] as RenderedEntry[] }
        buckets.set(parsed.parts.key, initial)
        return initial
      })()

    bucket.entries.push({
      uuid: message.uuid,
      timestampMs: rendered.timestampMs,
      batchTimeLabel: formatTimeLabel(parsed.date),
      line: rendered.line,
    })
  }

  return buckets
}

async function appendBucket(parts: DateParts, entries: RenderedEntry[]): Promise<void> {
  const state = await loadSeenState(parts)
  const seen = new Set(state.seenMessageUuids)
  const freshEntries = entries.filter(entry => !seen.has(entry.uuid))

  if (freshEntries.length === 0) {
    return
  }

  const transcriptPath = getTranscriptPath(parts)
  await mkdir(dirname(transcriptPath), { recursive: true })

  const segments: string[] = []
  if (!(await pathExists(transcriptPath))) {
    segments.push(`# Session transcript snippets for ${parts.key}`, '')
  }

  const batchLabel = freshEntries[0]?.batchTimeLabel ?? parts.key
  segments.push(`## ${batchLabel} - session ${getSessionId()}`)
  for (const entry of freshEntries) {
    segments.push(entry.line)
    seen.add(entry.uuid)
  }
  segments.push('')

  await appendFile(transcriptPath, `${segments.join('\n')}\n`, 'utf8')
  await saveSeenState(parts, {
    version: STATE_VERSION,
    seenMessageUuids: [...seen],
  })
}

async function writeBuckets(messages: Message[]): Promise<void> {
  const buckets = buildRenderedBuckets(messages)
  const orderedBuckets = [...buckets.values()].sort((left, right) =>
    left.parts.key.localeCompare(right.parts.key),
  )

  for (const bucket of orderedBuckets) {
    bucket.entries.sort((left, right) => left.timestampMs - right.timestampMs)
    await appendBucket(bucket.parts, bucket.entries)
  }
}

export async function writeSessionTranscriptSegment(
  messages: Message[],
): Promise<void> {
  if (!shouldWriteSessionTranscript() || messages.length === 0) {
    return
  }

  await enqueueWrite(async () => {
    await writeBuckets(messages)
  })
}

export async function flushOnDateChange(
  messages: Message[],
  currentDate: string,
): Promise<void> {
  if (!shouldWriteSessionTranscript() || messages.length === 0) {
    return
  }

  await enqueueWrite(async () => {
    const priorDayMessages = messages.filter(message => {
      if (!hasTimestamp(message)) {
        return false
      }
      const parsed = parseTimestampParts(message.timestamp)
      return parsed !== null && parsed.parts.key < currentDate
    })

    if (priorDayMessages.length === 0) {
      return
    }

    await writeBuckets(priorDayMessages)
  })
}
