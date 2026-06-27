import type {
  Message,
  SystemSnipBoundaryMessage,
  SystemSnipMarkerMessage,
} from '../../types/message.js'

export const SNIP_MARKER_SUBTYPE = 'snip_marker'
export const SNIP_BOUNDARY_SUBTYPE = 'snip_boundary'

export type SnipState = {
  activeMessages: Message[]
  removedUuids: Set<string>
  processedMarkerUuids: Set<string>
  pendingMarkers: SystemSnipMarkerMessage[]
}

export function isCompactBoundary(message: Message): boolean {
  return message.type === 'system' && message.subtype === 'compact_boundary'
}

export function lastCompactBoundaryIndex(messages: readonly Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isCompactBoundary(messages[i]!)) {
      return i
    }
  }
  return -1
}

export function isSnipMarkerMessage(
  message: unknown,
): message is SystemSnipMarkerMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    (message as { type?: unknown }).type === 'system' &&
    'subtype' in message &&
    (message as { subtype?: unknown }).subtype === SNIP_MARKER_SUBTYPE &&
    'snipMarker' in message
  )
}

export function isSnipBoundaryMessage(
  message: unknown,
): message is SystemSnipBoundaryMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    (message as { type?: unknown }).type === 'system' &&
    'subtype' in message &&
    (message as { subtype?: unknown }).subtype === SNIP_BOUNDARY_SUBTYPE &&
    'snipMetadata' in message
  )
}

export function collectSnipState(messages: readonly Message[]): SnipState {
  const compactBoundaryIndex = lastCompactBoundaryIndex(messages)
  const activeMessages = messages.slice(compactBoundaryIndex + 1)
  const removedUuids = new Set<string>()
  const processedMarkerUuids = new Set<string>()

  // Projection, pre-query execution, and resume all need the same notion of
  // "already applied" versus "still pending" snip state.
  for (const message of activeMessages) {
    if (!isSnipBoundaryMessage(message)) {
      continue
    }
    for (const uuid of message.snipMetadata.removedUuids) {
      removedUuids.add(uuid)
    }
    if (typeof message.snipMetadata.markerUuid === 'string') {
      processedMarkerUuids.add(message.snipMetadata.markerUuid)
    }
  }

  const pendingMarkers: SystemSnipMarkerMessage[] = []
  for (const message of activeMessages) {
    if (!isSnipMarkerMessage(message)) {
      continue
    }
    if (processedMarkerUuids.has(message.uuid)) {
      continue
    }
    pendingMarkers.push(message)
  }

  return {
    activeMessages,
    removedUuids,
    processedMarkerUuids,
    pendingMarkers,
  }
}
