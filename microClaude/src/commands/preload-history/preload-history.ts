import { readFile } from 'fs/promises'
import { resolve } from 'path'
import type { LocalCommandCall } from '../../types/command.js'
import type { Message, SystemMessageLevel } from '../../types/message.js'
import { getCwd } from '../../utils/cwd.js'
import {
  createAssistantMessage,
  createSystemMessage,
  createUserMessage,
} from '../../utils/messages.js'
import { clearConversation } from '../clear/conversation.js'

type ParsedHistoryEntry = {
  content: string
  isMeta?: boolean
  level?: SystemMessageLevel
  role: 'assistant' | 'system' | 'user'
  timestamp?: string
}

type ParsedHistoryFile = {
  messages: ParsedHistoryEntry[]
  title?: string
  version?: number
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function getOptionalString(
  value: unknown,
  fieldName: string,
  messageIndex: number,
): string | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string') {
    throw new Error(
      `history.messages[${messageIndex}].${fieldName} must be a string`,
    )
  }
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function parseHistoryEntry(value: unknown, messageIndex: number): ParsedHistoryEntry {
  const record = asRecord(value)
  if (!record) {
    throw new Error(`history.messages[${messageIndex}] must be an object`)
  }

  const role = getOptionalString(record.role, 'role', messageIndex)?.toLowerCase()
  if (role !== 'user' && role !== 'assistant' && role !== 'system') {
    throw new Error(
      `history.messages[${messageIndex}].role must be one of: user, assistant, system`,
    )
  }

  const content = getOptionalString(record.content, 'content', messageIndex)
  if (!content) {
    throw new Error(
      `history.messages[${messageIndex}].content must be a non-empty string`,
    )
  }

  const timestamp = getOptionalString(record.timestamp, 'timestamp', messageIndex)
  const levelString = getOptionalString(record.level, 'level', messageIndex)
  const level =
    levelString === undefined
      ? undefined
      : (['info', 'warning', 'error', 'suggestion'].includes(levelString)
          ? (levelString as SystemMessageLevel)
          : undefined)

  if (levelString !== undefined && level === undefined) {
    throw new Error(
      `history.messages[${messageIndex}].level must be one of: info, warning, error, suggestion`,
    )
  }

  const isMeta = record.isMeta
  if (isMeta !== undefined && typeof isMeta !== 'boolean') {
    throw new Error(
      `history.messages[${messageIndex}].isMeta must be a boolean`,
    )
  }

  return {
    content,
    ...(typeof isMeta === 'boolean' ? { isMeta } : {}),
    ...(level ? { level } : {}),
    role,
    ...(timestamp ? { timestamp } : {}),
  }
}

function parseHistoryFile(raw: string): ParsedHistoryFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (error) {
    throw new Error(
      `Failed to parse JSON: ${error instanceof Error ? error.message : 'Unknown error'}`,
    )
  }

  const root = asRecord(parsed)
  const messagesValue = Array.isArray(parsed)
    ? parsed
    : root && Array.isArray(root.messages)
      ? root.messages
      : null

  if (!messagesValue) {
    throw new Error(
      'History file must be either an array of messages or an object with a messages array',
    )
  }

  const version =
    root && typeof root.version === 'number' ? root.version : undefined
  if (version !== undefined && version !== 1) {
    throw new Error(
      `Unsupported history file version: ${String(version)}. Expected version 1.`,
    )
  }

  const title =
    root && typeof root.title === 'string' && root.title.trim() !== ''
      ? root.title.trim()
      : undefined

  const messages = messagesValue.map((entry, index) =>
    parseHistoryEntry(entry, index),
  )
  if (messages.length === 0) {
    throw new Error('History file must contain at least one message')
  }

  return {
    messages,
    ...(title ? { title } : {}),
    ...(version !== undefined ? { version } : {}),
  }
}

function createImportedMessage(entry: ParsedHistoryEntry): Message {
  if (entry.role === 'user') {
    const message = createUserMessage({
      content: entry.content,
      ...(entry.isMeta ? { isMeta: true } : {}),
    })
    return entry.timestamp ? { ...message, timestamp: entry.timestamp } : message
  }

  if (entry.role === 'assistant') {
    const message = createAssistantMessage({
      content: entry.content,
    })
    return entry.timestamp ? { ...message, timestamp: entry.timestamp } : message
  }

  const message = createSystemMessage(entry.content, entry.level ?? 'info')
  return entry.timestamp ? { ...message, timestamp: entry.timestamp } : message
}

export const call: LocalCommandCall = async (args, context) => {
  const fileArg = args.trim()
  if (!fileArg) {
    return {
      type: 'text',
      value:
        'Usage: /preload-history <json-file>\nExample: /preload-history docs/examples/preload-history.example.json',
    }
  }

  const filePath = resolve(getCwd(), fileArg)

  try {
    const raw = await readFile(filePath, 'utf-8')
    const parsed = parseHistoryFile(raw)
    const importedMessages = parsed.messages.map(createImportedMessage)

    await clearConversation(context)
    context.setMessages(prev => [...prev, ...importedMessages])

    const counts = {
      assistant: parsed.messages.filter(message => message.role === 'assistant')
        .length,
      system: parsed.messages.filter(message => message.role === 'system').length,
      user: parsed.messages.filter(message => message.role === 'user').length,
    }

    const parts = [
      `${parsed.messages.length} messages`,
      `${counts.user} user`,
      `${counts.assistant} assistant`,
    ]
    if (counts.system > 0) {
      parts.push(`${counts.system} system`)
    }

    const titleSuffix = parsed.title ? ` (${parsed.title})` : ''
    return {
      type: 'text',
      value: `Preloaded ${parts.join(', ')} from ${filePath}${titleSuffix} into a fresh session.`,
    }
  } catch (error) {
    return {
      type: 'text',
      value: `Failed to preload history from ${filePath}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
