import type { Attachment } from '../../utils/attachments.js'
import { logError } from '../../utils/log.js'
import { getDynamicSkills } from '../../skills/loadSkillsDir.js'
import { toolMatchesName, type ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { SKILL_TOOL_NAME } from '../../tools/SkillTool/constants.js'
import type { DiscoverySignal } from './signals.js'
import { isSkillSearchEnabled } from './featureCheck.js'
import { searchSkills, type SkillSearchResult } from './localSearch.js'

const WRITE_PIVOT_TOOL_NAMES = new Set([
  'Bash',
  'PowerShell',
  'Write',
  'Edit',
  'NotebookEdit',
])

type SkillDiscoveryAttachment = Extract<Attachment, { type: 'skill_discovery' }>

export type SkillDiscoveryPrefetchHandle = {
  promise: Promise<Attachment[]>
  settledAt: number | null
  consumedOnIteration: number
}

function createPrefetchHandle(
  promise: Promise<Attachment[]>,
): SkillDiscoveryPrefetchHandle {
  const handle: SkillDiscoveryPrefetchHandle = {
    promise,
    settledAt: null,
    consumedOnIteration: -1,
  }

  void promise.finally(() => {
    handle.settledAt = Date.now()
  })

  return handle
}

function getMessageText(message: Message): string {
  if (message.type !== 'assistant' && message.type !== 'user') {
    return ''
  }

  const content = message.message.content
  if (typeof content === 'string') {
    return content
  }

  return content
    .map(block => {
      if (block.type === 'text') {
        return block.text
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function getLatestUserQuery(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.type !== 'user' || message.isMeta || message.toolUseResult) {
      continue
    }

    const text = getMessageText(message).trim()
    if (text) {
      return text
    }
  }

  return ''
}

function extractAssistantToolUseNames(message: Message): Set<string> {
  if (message.type !== 'assistant') {
    return new Set()
  }

  const toolNames = new Set<string>()
  for (const block of message.message.content) {
    if (block.type === 'tool_use' && block.name) {
      toolNames.add(block.name)
    }
  }
  return toolNames
}

function hasRecentWritePivot(messages: readonly Message[]): boolean {
  let sawToolResult = false

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message) {
      continue
    }

    if (
      message.type === 'user' &&
      Array.isArray(message.message.content) &&
      message.message.content.some(block => block.type === 'tool_result')
    ) {
      sawToolResult = true
      continue
    }

    if (sawToolResult && message.type === 'assistant') {
      const toolNames = extractAssistantToolUseNames(message)
      if (toolNames.size === 0) {
        return false
      }
      for (const toolName of toolNames) {
        if (WRITE_PIVOT_TOOL_NAMES.has(toolName)) {
          return true
        }
      }
      return false
    }

    if (sawToolResult) {
      continue
    }
  }

  return false
}

function normalizeSkillDiscoveryAttachment(
  attachment: SkillDiscoveryAttachment,
): SkillDiscoveryAttachment {
  const { hidden_by_main_turn, ...rest } = attachment
  return rest
}

function hasMatchingSkillDiscoveryAttachment(
  messages: readonly Message[],
  attachment: SkillDiscoveryAttachment,
): boolean {
  const normalizedTarget = JSON.stringify(
    normalizeSkillDiscoveryAttachment(attachment),
  )

  return messages.some(message => {
    if (
      message.type !== 'attachment' ||
      message.attachment.type !== 'skill_discovery'
    ) {
      return false
    }

    return (
      JSON.stringify(
        normalizeSkillDiscoveryAttachment(message.attachment),
      ) === normalizedTarget
    )
  })
}

function buildFilesystemFallbackAttachment(
  messages: readonly Message[],
  discoveredSkillNames: Set<string> | undefined,
): Attachment[] {
  const skills = getDynamicSkills()
    .filter(cmd => !discoveredSkillNames?.has(cmd.name))
    .slice(0, 5)
    .map<SkillSearchResult>(cmd => ({
      name: cmd.name,
      description: cmd.whenToUse
        ? `${cmd.description} - ${cmd.whenToUse}`
        : cmd.description,
    }))

  if (skills.length === 0) {
    return []
  }

  for (const skill of skills) {
    discoveredSkillNames?.add(skill.name)
  }

  const attachment: SkillDiscoveryAttachment = {
    type: 'skill_discovery',
    skills,
    signal: 'filesystem',
    source: 'native',
  }

  return hasMatchingSkillDiscoveryAttachment(messages, attachment)
    ? []
    : [attachment]
}

async function buildSkillDiscoveryAttachments(
  signalInput: string | null,
  messages: readonly Message[],
  toolUseContext: ToolUseContext,
  signal: DiscoverySignal,
): Promise<Attachment[]> {
  if (
    !toolUseContext.options.tools.some(tool =>
      toolMatchesName(tool, SKILL_TOOL_NAME),
    )
  ) {
    return []
  }

  const query = (signalInput ?? getLatestUserQuery(messages)).trim()
  const discoveredSkillNames = toolUseContext.discoveredSkillNames
  const skills = await searchSkills(query, toolUseContext, {
    limit: 5,
    excludeNames: discoveredSkillNames,
  })

  if (skills.length === 0) {
    if (signal !== 'user_message') {
      return buildFilesystemFallbackAttachment(messages, discoveredSkillNames)
    }
    return []
  }

  for (const skill of skills) {
    discoveredSkillNames?.add(skill.name)
  }

  const attachment: SkillDiscoveryAttachment = {
    type: 'skill_discovery',
    skills,
    signal,
    source: 'native',
  }

  return hasMatchingSkillDiscoveryAttachment(messages, attachment)
    ? []
    : [attachment]
}

export async function getTurnZeroSkillDiscovery(
  input: string,
  messages: readonly Message[],
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  if (!isSkillSearchEnabled()) {
    return []
  }

  return buildSkillDiscoveryAttachments(
    input,
    messages,
    toolUseContext,
    'user_message',
  )
}

export function startSkillDiscoveryPrefetch(
  signalInput: string | null,
  messages: readonly Message[],
  toolUseContext: ToolUseContext,
): SkillDiscoveryPrefetchHandle | null {
  if (!isSkillSearchEnabled() || !hasRecentWritePivot(messages)) {
    return null
  }

  const signal: DiscoverySignal = toolUseContext.agentId
    ? 'subagent_spawn'
    : 'assistant_turn'

  return createPrefetchHandle(
    buildSkillDiscoveryAttachments(
      signalInput,
      messages,
      toolUseContext,
      signal,
    ).catch(error => {
      logError(error)
      return []
    }),
  )
}

export async function collectSkillDiscoveryPrefetch(
  prefetch: SkillDiscoveryPrefetchHandle,
): Promise<Attachment[]> {
  if (prefetch.consumedOnIteration !== -1) {
    return []
  }

  // settledAt is latched by promise.finally(); if it's already set when we
  // reach the collect point, discovery completed "under" the main turn and
  // the attachment can stay hidden in the live UI while still reaching the
  // model on the next round-trip.
  const hiddenByMainTurn = prefetch.settledAt !== null
  const attachments = await prefetch.promise
  prefetch.consumedOnIteration = 0

  return attachments.map(attachment => {
    if (attachment.type !== 'skill_discovery') {
      return attachment
    }
    return {
      ...attachment,
      hidden_by_main_turn: hiddenByMainTurn,
    }
  })
}
