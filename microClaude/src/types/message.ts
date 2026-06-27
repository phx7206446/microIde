import type { APIError } from '@anthropic-ai/sdk'
import type {
  BetaContentBlock,
  BetaMessage,
  BetaRawMessageStreamEvent,
  BetaToolUseBlock,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { ContentBlockParam, ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { UUID } from 'crypto'
import type { SDKAssistantMessageError } from 'src/entrypoints/agentSdkTypes.js'
import type { Attachment } from '../utils/attachments.js'
import type { PermissionMode } from './permissions.js'
import type { HookProgress } from './hooks.js'
import type { ToolProgressData } from './tools.js'

export type MessageOrigin =
  | { kind: 'human' }
  | { kind: 'task-notification' }
  | { kind: 'loop'; taskId: string }
  | { kind: 'coordinator' }
  | { kind: 'channel'; server: string }

export type PartialCompactDirection = 'from' | 'up_to'

export type SystemMessageLevel = 'info' | 'warning' | 'error' | 'suggestion'

export type StopHookInfo = {
  command: string
  durationMs?: number
  promptText?: string
  [key: string]: unknown
}

export type CompactMetadata = {
  trigger: 'manual' | 'auto'
  preTokens: number
  userContext?: string
  messagesSummarized?: number
  preservedSegment?: {
    headUuid: UUID
    anchorUuid: UUID
    tailUuid: UUID
  }
  preCompactDiscoveredTools?: string[]
}

export type MicrocompactMetadata = {
  trigger: 'auto'
  preTokens: number
  tokensSaved: number
  compactedToolIds: string[]
  clearedAttachmentUUIDs: string[]
}

export type SnipMarkerMetadata = {
  removedUuids: string[]
  removedMessageIds: string[]
  removedCount: number
  tokensFreed: number
  reason?: string
}

export type SnipMetadata = SnipMarkerMetadata & {
  markerUuid?: UUID
}

type MessageCommon = {
  uuid: UUID
  timestamp: string
  isMeta?: boolean
}

type AssistantAPIMessage<C extends BetaContentBlock = BetaContentBlock> = Omit<
  BetaMessage,
  'content'
> & {
  content: C[]
  context_management?: BetaMessage['context_management'] | null
}

type UserAPIMessage<C extends ContentBlockParam = ContentBlockParam> = {
  role: 'user'
  content: string | C[]
}

export type AssistantMessage<C extends BetaContentBlock = BetaContentBlock> =
  MessageCommon & {
    type: 'assistant'
    message: AssistantAPIMessage<C>
    requestId?: string
    research?: unknown
    apiError?: 'max_output_tokens' | string
    error?: SDKAssistantMessageError
    errorDetails?: string
    isApiErrorMessage?: boolean
    isVirtual?: true
    advisorModel?: string
  }

export type UserMessage<C extends ContentBlockParam = ContentBlockParam> =
  MessageCommon & {
    type: 'user'
    message: UserAPIMessage<C>
    isVisibleInTranscriptOnly?: true
    isVirtual?: true
    isCompactSummary?: true
    summarizeMetadata?: {
      messagesSummarized: number
      userContext?: string
      direction?: PartialCompactDirection
    }
    toolUseResult?: unknown
    mcpMeta?: {
      _meta?: Record<string, unknown>
      structuredContent?: Record<string, unknown>
    }
    imagePasteIds?: number[]
    sourceToolAssistantUUID?: UUID
    sourceToolUseID?: string
    permissionMode?: PermissionMode
    origin?: MessageOrigin
    planContent?: string
  }

export type AttachmentMessage<A extends Attachment = Attachment> = MessageCommon & {
  type: 'attachment'
  attachment: A
}

export type ProgressMessage<P = ToolProgressData | HookProgress> = {
  type: 'progress'
  data: P
  toolUseID: string
  parentToolUseID: string
  uuid: string
  timestamp: string
}

type SystemMessageBase<S extends string> = MessageCommon & {
  type: 'system'
  subtype: S
  content?: string
  level?: SystemMessageLevel
  toolUseID?: string
}

export type SystemInformationalMessage = SystemMessageBase<'informational'> & {
  content: string
  level: SystemMessageLevel
  preventContinuation?: boolean
}

export type SystemPermissionRetryMessage =
  SystemMessageBase<'permission_retry'> & {
    content: string
    level: 'info'
    commands: string[]
  }

export type SystemBridgeStatusMessage = SystemMessageBase<'bridge_status'> & {
  content: string
  url: string
  upgradeNudge?: string
}

export type SystemScheduledTaskFireMessage =
  SystemMessageBase<'scheduled_task_fire'> & {
    content: string
  }

export type SystemStopHookSummaryMessage =
  SystemMessageBase<'stop_hook_summary'> & {
    hookCount: number
    hookInfos: StopHookInfo[]
    hookErrors: string[]
    preventedContinuation: boolean
    stopReason?: string
    hasOutput: boolean
    level: SystemMessageLevel
    hookLabel?: string
    totalDurationMs?: number
  }

export type SystemTurnDurationMessage =
  SystemMessageBase<'turn_duration'> & {
    durationMs: number
    budgetTokens?: number
    budgetLimit?: number
    budgetNudges?: number
    messageCount?: number
  }

export type SystemAwaySummaryMessage = SystemMessageBase<'away_summary'> & {
  content: string
}

export type SystemMemorySavedMessage = SystemMessageBase<'memory_saved'> & {
  writtenPaths: string[]
  teamCount?: number
  verb?: string
}

export type SystemAgentsKilledMessage =
  SystemMessageBase<'agents_killed'>

export type SystemApiMetricsMessage = SystemMessageBase<'api_metrics'> & {
  ttftMs: number
  otps: number
  isP50?: boolean
  hookDurationMs?: number
  turnDurationMs?: number
  toolDurationMs?: number
  classifierDurationMs?: number
  toolCount?: number
  hookCount?: number
  classifierCount?: number
  configWriteCount?: number
}

export type SystemLocalCommandMessage =
  SystemMessageBase<'local_command'> & {
    content: string
    level: 'info'
  }

export type SystemCompactBoundaryMessage =
  SystemMessageBase<'compact_boundary'> & {
    content: string
    level: 'info'
    compactMetadata: CompactMetadata
    logicalParentUuid?: UUID
  }

export type SystemMicrocompactBoundaryMessage =
  SystemMessageBase<'microcompact_boundary'> & {
    content: string
    level: 'info'
    microcompactMetadata: MicrocompactMetadata
  }

export type SystemSnipMarkerMessage = SystemMessageBase<'snip_marker'> & {
  content: string
  level: 'info'
  snipMarker: SnipMarkerMetadata
}

export type SystemSnipBoundaryMessage = SystemMessageBase<'snip_boundary'> & {
  content: string
  level: 'info'
  snipMetadata: SnipMetadata
}

export type SystemAPIErrorMessage = SystemMessageBase<'api_error'> & {
  level: 'error'
  error: APIError
  retryInMs: number
  retryAttempt: number
  maxRetries: number
  cause?: Error
}

export type SystemFileSnapshotMessage =
  SystemMessageBase<'file_snapshot'> & {
    content: string
    level: 'info'
    snapshotFiles: Array<{
      key: string
      path: string
      content: string
    }>
  }

export type SystemThinkingMessage = SystemMessageBase<'thinking'> & {
  content?: string
}

export type SystemMessage =
  | SystemInformationalMessage
  | SystemPermissionRetryMessage
  | SystemBridgeStatusMessage
  | SystemScheduledTaskFireMessage
  | SystemStopHookSummaryMessage
  | SystemTurnDurationMessage
  | SystemAwaySummaryMessage
  | SystemMemorySavedMessage
  | SystemAgentsKilledMessage
  | SystemApiMetricsMessage
  | SystemLocalCommandMessage
  | SystemCompactBoundaryMessage
  | SystemMicrocompactBoundaryMessage
  | SystemSnipMarkerMessage
  | SystemSnipBoundaryMessage
  | SystemAPIErrorMessage
  | SystemFileSnapshotMessage
  | SystemThinkingMessage

export type StreamEvent = {
  type: 'stream_event'
  event: BetaRawMessageStreamEvent
  ttftMs?: number
  uuid?: UUID
  session_id?: string
  parent_tool_use_id?: string | null
}

export type RequestStartEvent = {
  type: 'stream_request_start'
}

export type TombstoneMessage = {
  type: 'tombstone'
  message: Message
}

export type ToolUseSummaryMessage = {
  type: 'tool_use_summary'
  summary: string
  precedingToolUseIds: string[]
  uuid: UUID
  timestamp: string
}

export type Message =
  | AssistantMessage
  | UserMessage
  | AttachmentMessage
  | ProgressMessage
  | SystemMessage
  | ToolUseSummaryMessage

export type QueryLifecycleMessage =
  | StreamEvent
  | RequestStartEvent
  | TombstoneMessage

export type TranscriptCapableMessage =
  | AssistantMessage
  | UserMessage
  | AttachmentMessage
  | SystemMessage

export type MessageWithUUID = Message

export function hasMessageUuid(
  message: Message | QueryLifecycleMessage | undefined | null,
): message is MessageWithUUID {
  return !!message && 'uuid' in message && typeof message.uuid === 'string'
}

export type NormalizedAssistantMessage<
  C extends BetaContentBlock = BetaContentBlock,
> = Omit<AssistantMessage<C>, 'message'> & {
  message: Omit<AssistantAPIMessage<C>, 'content'> & { content: [C] }
}

export type NormalizedUserMessage<
  C extends ContentBlockParam = ContentBlockParam,
> = Omit<UserMessage<C>, 'message'> & {
  message: Omit<UserAPIMessage<C>, 'content'> & { content: [C] }
}

export type NormalizedMessage =
  | NormalizedAssistantMessage
  | NormalizedUserMessage
  | AttachmentMessage
  | ProgressMessage
  | SystemMessage

export type GroupedToolUseMessage = {
  type: 'grouped_tool_use'
  toolName: string
  messages: NormalizedAssistantMessage<BetaToolUseBlock>[]
  results: NormalizedUserMessage[]
  displayMessage: NormalizedAssistantMessage<BetaToolUseBlock>
  uuid: UUID
  timestamp: string
  messageId: string
}

export type CollapsibleMessage =
  | NormalizedAssistantMessage
  | NormalizedUserMessage
  | GroupedToolUseMessage

export type CollapsedReadSearchGroup = {
  type: 'collapsed_read_search'
  searchCount: number
  readCount: number
  listCount: number
  replCount: number
  memorySearchCount: number
  memoryReadCount: number
  memoryWriteCount: number
  teamMemorySearchCount?: number
  teamMemoryReadCount?: number
  teamMemoryWriteCount?: number
  readFilePaths: string[]
  searchArgs: string[]
  latestDisplayHint?: string
  messages: CollapsibleMessage[]
  displayMessage: CollapsibleMessage
  uuid: UUID
  timestamp: string
  mcpCallCount?: number
  mcpServerNames?: string[]
  bashCount?: number
  gitOpBashCount?: number
  commits?: Array<{ sha: string; kind: string }>
  pushes?: Array<{ branch: string }>
  branches?: Array<{ action: string; ref: string }>
  prs?: Array<{ action: string; number?: number; url?: string }>
  hookTotalMs?: number
  hookCount?: number
  hookInfos?: StopHookInfo[]
  relevantMemories?: Array<{
    path: string
    content: string
    mtimeMs: number
    header?: string
    limit?: number
  }>
}

export type RenderableMessage =
  | NormalizedAssistantMessage
  | NormalizedUserMessage
  | AttachmentMessage
  | SystemMessage
  | GroupedToolUseMessage
  | CollapsedReadSearchGroup

export type HookResultMessage =
  | AttachmentMessage
  | ProgressMessage<HookProgress>
