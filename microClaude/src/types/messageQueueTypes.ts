import type { UUID } from 'crypto'

export type QueueOperation = 'enqueue' | 'dequeue' | 'remove' | 'popAll'

export type QueueOperationMessage = {
  type: 'queue-operation'
  operation: QueueOperation
  timestamp: string
  sessionId: UUID | string
  content?: string
}
