import { randomUUID } from 'crypto'
import type {
  Message,
  SnipMarkerMetadata,
  SnipMetadata,
  SystemSnipBoundaryMessage,
  SystemSnipMarkerMessage,
  UserMessage,
} from '../../types/message.js'
import { hasMessageUuid } from '../../types/message.js'
import { tokenCountWithEstimation } from '../../utils/tokens.js'
import {
  collectSnipState,
  isCompactBoundary,
  isSnipBoundaryMessage,
  isSnipMarkerMessage,
  lastCompactBoundaryIndex,
  SNIP_BOUNDARY_SUBTYPE,
  SNIP_MARKER_SUBTYPE,
} from './snipState.js'

export { SNIP_MARKER_SUBTYPE, SNIP_BOUNDARY_SUBTYPE }

const DEFAULT_KEEP_RECENT_TURNS = 2
const NUDGE_INTERVAL_TOKENS = 10_000

export type SnipCompactResult<T> = {
  messages: T[]
  tokensFreed: number
  boundaryMessage?: T
  executed: boolean
}

export type SnipSelectionPlan = {
  removedUuids: string[]
  removedMessageIds: string[]
  removedCount: number
  skippedMessageIds: string[]
  tokensFreed: number
  reason?: string
}

type SnipTurn = {
  shortId: string
  startIdx: number
  endIdx: number
}

type AttachmentLike = {
  type: 'attachment'
  attachment?: { type?: string }
}

export const SNIP_NUDGE_TEXT =
  'If older user turns are no longer needed, use Snip to remove those turns from the active context and keep the conversation lean.'

function deriveShortMessageId(uuid: string): string {
  const hex = uuid.replace(/-/g, '').slice(0, 10)
  return parseInt(hex, 16).toString(36).slice(0, 6)
}

function isTextualUserTurn(message: Message): message is UserMessage {
  if (message.type !== 'user' || message.isMeta) {
    return false
  }

  const content = message.message.content
  if (typeof content === 'string') {
    return content.trim() !== ''
  }

  const hasToolResult = content.some(block => block.type === 'tool_result')
  if (hasToolResult) {
    return false
  }

  return content.some(block => block.type === 'text')
}

function isContextEfficiencyAttachment(message: unknown): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    (message as { type?: unknown }).type === 'attachment' &&
    ((message as AttachmentLike).attachment?.type ?? null) ===
      'context_efficiency'
  )
}

function buildTurnList(messages: readonly Message[]): SnipTurn[] {
  const turns: SnipTurn[] = []

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!
    if (!isTextualUserTurn(message)) {
      continue
    }

    if (turns.length > 0) {
      turns[turns.length - 1]!.endIdx = i
    }

    turns.push({
      shortId: deriveShortMessageId(message.uuid),
      startIdx: i,
      endIdx: messages.length,
    })
  }

  return turns
}

function filterRemovableTurnMessages(
  messages: readonly Message[],
  turn: SnipTurn,
): string[] {
  const removed: string[] = []

  for (let i = turn.startIdx; i < turn.endIdx; i++) {
    const message = messages[i]!

    if (
      isCompactBoundary(message) ||
      isSnipBoundaryMessage(message) ||
      isSnipMarkerMessage(message) ||
      !hasMessageUuid(message)
    ) {
      continue
    }

    removed.push(message.uuid)
  }

  return removed
}

function filterProjectedMessages(
  messages: readonly Message[],
  removedUuids: ReadonlySet<string>,
  options?: {
    hideMarkers?: boolean
    hiddenMarkerUuids?: ReadonlySet<string>
  },
): Message[] {
  return messages.filter(message => {
    if (hasMessageUuid(message) && removedUuids.has(message.uuid)) {
      return false
    }
    if (isSnipMarkerMessage(message)) {
      if (options?.hideMarkers) {
        return false
      }
      if (options?.hiddenMarkerUuids?.has(message.uuid)) {
        return false
      }
    }
    return true
  })
}

function collectBoundaryRemovedUuids(messages: readonly Message[]): Set<string> {
  return collectSnipState(messages).removedUuids
}

function buildBoundaryMetadata(
  marker: SystemSnipMarkerMessage,
  tokensFreed: number,
): SnipMetadata {
  return {
    ...marker.snipMarker,
    markerUuid: marker.uuid,
    tokensFreed,
  }
}

function createBoundaryFromMarker(
  marker: SystemSnipMarkerMessage,
  tokensFreed: number,
): SystemSnipBoundaryMessage {
  return {
    type: 'system',
    subtype: SNIP_BOUNDARY_SUBTYPE,
    content: 'Conversation context trimmed',
    level: 'info',
    isMeta: false,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
    snipMetadata: buildBoundaryMetadata(marker, tokensFreed),
  }
}

function normalizeMessageIds(messageIds: readonly string[]): string[] {
  return [...new Set(messageIds.map(id => id.trim()).filter(Boolean))]
}

export function listSnippableMessageIds(
  messages: readonly Message[],
  keepRecentTurns = DEFAULT_KEEP_RECENT_TURNS,
): string[] {
  const turns = buildTurnList(messages)
  const protectedStart = Math.max(0, turns.length - keepRecentTurns)
  return turns.slice(0, protectedStart).map(turn => turn.shortId)
}

export function planSnipFromMessageIds(
  messages: readonly Message[],
  messageIds: readonly string[],
  reason?: string,
  keepRecentTurns = DEFAULT_KEEP_RECENT_TURNS,
): SnipSelectionPlan {
  const turns = buildTurnList(messages)
  const requestedIds = normalizeMessageIds(messageIds)
  const protectedIds = new Set(
    turns.slice(-keepRecentTurns).map(turn => turn.shortId),
  )
  const turnById = new Map(turns.map(turn => [turn.shortId, turn]))
  const removedUuidSet = new Set<string>()
  const removedMessageIds: string[] = []
  const skippedMessageIds: string[] = []

  for (const messageId of requestedIds) {
    const turn = turnById.get(messageId)
    if (!turn || protectedIds.has(messageId)) {
      skippedMessageIds.push(messageId)
      continue
    }

    removedMessageIds.push(messageId)
    for (const uuid of filterRemovableTurnMessages(messages, turn)) {
      removedUuidSet.add(uuid)
    }
  }

  const projectedBefore = filterProjectedMessages(messages, new Set(), {
    hideMarkers: true,
  })
  const projectedAfter = filterProjectedMessages(messages, removedUuidSet, {
    hideMarkers: true,
  })
  const tokensFreed =
    removedUuidSet.size === 0
      ? 0
      : Math.max(
          0,
          tokenCountWithEstimation(projectedBefore) -
            tokenCountWithEstimation(projectedAfter),
        )

  return {
    removedUuids: [...removedUuidSet],
    removedMessageIds,
    removedCount: removedUuidSet.size,
    skippedMessageIds,
    tokensFreed,
    reason,
  }
}

export function createSnipMarkerMessage(
  selection: SnipSelectionPlan,
): SystemSnipMarkerMessage {
  const snipMarker: SnipMarkerMetadata = {
    removedUuids: selection.removedUuids,
    removedMessageIds: selection.removedMessageIds,
    removedCount: selection.removedCount,
    tokensFreed: selection.tokensFreed,
    reason: selection.reason,
  }

  return {
    type: 'system',
    subtype: SNIP_MARKER_SUBTYPE,
    content: 'Snip queued',
    level: 'info',
    isMeta: false,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
    snipMarker,
  }
}

export function createSnipBoundaryMessage(
  selection: SnipSelectionPlan,
): SystemSnipBoundaryMessage {
  return {
    type: 'system',
    subtype: SNIP_BOUNDARY_SUBTYPE,
    content: 'Conversation context trimmed',
    level: 'info',
    isMeta: false,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
    snipMetadata: {
      removedUuids: selection.removedUuids,
      removedMessageIds: selection.removedMessageIds,
      removedCount: selection.removedCount,
      tokensFreed: selection.tokensFreed,
      reason: selection.reason,
    },
  }
}

export function snipCompactIfNeeded<T>(
  messages: T[],
  options?: { force?: boolean },
): SnipCompactResult<T> {
  if (!isSnipRuntimeEnabled()) {
    return {
      messages,
      tokensFreed: 0,
      executed: false,
    }
  }

  const typedMessages = messages as Message[]
  const {
    removedUuids: alreadyRemoved,
    processedMarkerUuids,
    pendingMarkers,
  } = collectSnipState(typedMessages)
  const pendingMarker =
    pendingMarkers.length > 0
      ? pendingMarkers[pendingMarkers.length - 1]
      : undefined

  if (!pendingMarker) {
    return {
      messages: filterProjectedMessages(typedMessages, alreadyRemoved, {
        hiddenMarkerUuids: processedMarkerUuids,
      }) as T[],
      tokensFreed: 0,
      executed: false,
    }
  }

  const removedWithPending = new Set(alreadyRemoved)
  for (const uuid of pendingMarker.snipMarker.removedUuids) {
    removedWithPending.add(uuid)
  }

  // Execute one queued snip per iteration, but preserve any older pending
  // markers so resumed sessions and multi-Snip tool batches can drain them
  // on subsequent turns.
  const hiddenMarkerUuids = new Set(processedMarkerUuids)
  hiddenMarkerUuids.add(pendingMarker.uuid)
  const projected = filterProjectedMessages(typedMessages, removedWithPending, {
    hiddenMarkerUuids,
  })
  const tokensFreed = pendingMarker.snipMarker.tokensFreed
  const boundary = createBoundaryFromMarker(pendingMarker, tokensFreed)

  if (options?.force) {
    return {
      messages: [...projected, boundary] as T[],
      tokensFreed,
      executed: true,
    }
  }

  return {
    messages: projected as T[],
    tokensFreed,
    boundaryMessage: boundary as T,
    executed: true,
  }
}

export { isSnipMarkerMessage }

export function isSnipRuntimeEnabled(): boolean {
  return process.env.USER_TYPE === 'ant'
}

export function shouldNudgeForSnips(messages: unknown[]): boolean {
  if (!isSnipRuntimeEnabled()) {
    return false
  }

  const typedMessages = messages.filter(
    (message): message is Message =>
      typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      typeof (message as { type?: unknown }).type === 'string',
  )

  let resetIndex = lastCompactBoundaryIndex(typedMessages)
  for (let i = resetIndex + 1; i < typedMessages.length; i++) {
    const message = typedMessages[i]!
    if (
      isSnipMarkerMessage(message) ||
      isSnipBoundaryMessage(message) ||
      isContextEfficiencyAttachment(message)
    ) {
      resetIndex = i
    }
  }

  const windowMessages = typedMessages.slice(resetIndex + 1)
  if (windowMessages.length === 0) {
    return false
  }

  const projected = filterProjectedMessages(
    windowMessages,
    collectBoundaryRemovedUuids(windowMessages),
    { hideMarkers: true },
  )

  return tokenCountWithEstimation(projected) >= NUDGE_INTERVAL_TOKENS
}
