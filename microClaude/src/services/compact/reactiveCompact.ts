import type { QuerySource } from '../../constants/querySource.js'
import type { Message, StreamEvent } from '../../types/message.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import type { CompactionResult } from './compact.js'

type TryReactiveCompactParams = {
  hasAttempted: boolean
  querySource?: QuerySource
  aborted: boolean
  messages: Message[]
  cacheSafeParams: CacheSafeParams
}

type ReactiveCompactOptions = {
  customInstructions?: string
  trigger: 'manual' | 'auto'
}

type ReactiveCompactFailureReason =
  | 'aborted'
  | 'too_few_groups'
  | 'exhausted'
  | 'error'
  | 'media_unstrippable'

export type ReactiveCompactOutcome =
  | { ok: true; result: CompactionResult }
  | { ok: false; reason: ReactiveCompactFailureReason }

// Both upstream snapshots reference this module from query/compact entrypoints
// but do not include its implementation. Keep the call surface intact and
// default the feature off rather than inventing compaction behavior.
export function isReactiveCompactEnabled(): boolean {
  return false
}

export function isReactiveOnlyMode(): boolean {
  return false
}

export function isWithheldPromptTooLong(
  _message: Message | StreamEvent | undefined,
): boolean {
  return false
}

export function isWithheldMediaSizeError(
  _message: Message | StreamEvent | undefined,
): boolean {
  return false
}

export async function tryReactiveCompact(
  _params: TryReactiveCompactParams,
): Promise<CompactionResult | null> {
  return null
}

export async function reactiveCompactOnPromptTooLong(
  _messages: Message[],
  _cacheSafeParams: CacheSafeParams,
  options: ReactiveCompactOptions,
): Promise<ReactiveCompactOutcome> {
  return {
    ok: false,
    reason: options.trigger === 'manual' ? 'too_few_groups' : 'exhausted',
  }
}
