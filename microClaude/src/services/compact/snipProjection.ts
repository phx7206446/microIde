import type {
  Message,
} from '../../types/message.js'
import { hasMessageUuid } from '../../types/message.js'
import {
  collectSnipState,
  isSnipBoundaryMessage,
  isSnipMarkerMessage,
} from './snipState.js'

export function projectSnippedView<T>(messages: T[]): T[] {
  const typedMessages = messages as Message[]
  const { pendingMarkers, removedUuids } = collectSnipState(typedMessages)
  const pendingMarkerUuids = new Set(
    pendingMarkers.map(marker => marker.uuid),
  )

  return typedMessages.filter(message => {
    if (hasMessageUuid(message) && removedUuids.has(message.uuid)) {
      return false
    }
    if (isSnipMarkerMessage(message)) {
      return pendingMarkerUuids.has(message.uuid)
    }
    return true
  }) as T[]
}

export { isSnipBoundaryMessage }
