/**
 * Main entrypoint for Claude Code Agent SDK types.
 *
 * This file re-exports the public SDK API from:
 * - sdk/coreTypes.ts - Common serializable types (messages, configs)
 * - sdk/runtimeTypes.ts - Non-serializable types (callbacks, interfaces)
 *
 * SDK builders who need control protocol types should import from
 * sdk/controlTypes.ts directly.
 */

import type {
  CallToolResult,
  ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { randomUUID, type UUID } from 'crypto'
import { appendFile, mkdir, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { z } from 'zod/v4'

// Control protocol types for SDK builders (bridge subpath consumers)
/** @alpha */
export type {
  SDKControlRequest,
  SDKControlResponse,
} from './sdk/controlTypes.js'
// Re-export core types (common serializable types)
export * from './sdk/coreTypes.js'
// Re-export runtime types (callbacks, interfaces with methods)
export * from './sdk/runtimeTypes.js'

// Re-export settings types (generated from settings JSON schema)
export type { Settings } from './sdk/settingsTypes.generated.js'
// Re-export tool types (all marked @internal until SDK API stabilizes)
export * from './sdk/toolTypes.js'

// ============================================================================
// Functions
// ============================================================================

import type {
  HookInput,
  SDKMessage,
  SDKResultMessage,
  SDKSessionInfo,
  SessionMessage,
  SDKUserMessage,
} from './sdk/coreTypes.js'
// Import types needed for function signatures
import type {
  AnyZodRawShape,
  ForkSessionOptions,
  ForkSessionResult,
  GetSessionInfoOptions,
  GetSessionMessagesOptions,
  InferShape,
  InternalOptions,
  InternalQuery,
  ListSessionsOptions,
  McpSdkServerConfigWithInstance,
  Options,
  Query,
  SDKSession,
  SDKSessionOptions,
  SdkMcpToolDefinition,
  SessionMutationOptions,
} from './sdk/runtimeTypes.js'
import type { TranscriptMessage } from '../types/logs.js'
import type { CompactMetadata, Message } from '../types/message.js'
import { buildMissedTaskNotification as formatMissedTaskNotification } from '../utils/scheduledTaskNotifications.js'
import {
  listSessionsImpl,
  parseSessionInfoFromLite,
} from '../utils/listSessionsImpl.js'
import {
  readSessionLite,
  resolveSessionFilePath,
  validateUuid,
} from '../utils/sessionStoragePortable.js'

export type {
  ListSessionsOptions,
  GetSessionInfoOptions,
  SessionMutationOptions,
  ForkSessionOptions,
  ForkSessionResult,
  SDKSessionInfo,
}

type SessionOptionRecord = Record<string, unknown>

function getOptionRecord(value: unknown): SessionOptionRecord {
  return value && typeof value === 'object' ? (value as SessionOptionRecord) : {}
}

function getStringOption(
  options: SessionOptionRecord,
  key: string,
): string | undefined {
  const value = options[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function getBooleanOption(
  options: SessionOptionRecord,
  key: string,
): boolean | undefined {
  const value = options[key]
  return typeof value === 'boolean' ? value : undefined
}

function getNonNegativeIntegerOption(
  options: SessionOptionRecord,
  key: string,
): number | undefined {
  const value = options[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined
  }
  return Math.trunc(value)
}

function requireUuid(value: string, label: string): UUID {
  const uuid = validateUuid(value)
  if (!uuid) {
    throw new TypeError(`${label} must be a valid UUID`)
  }
  return uuid
}

function findLatestByTimestamp<T extends { timestamp: string }>(
  messages: Iterable<T>,
  predicate: (message: T) => boolean,
): T | undefined {
  let latest: T | undefined
  let latestTimestamp = -Infinity

  for (const message of messages) {
    if (!predicate(message)) continue
    const parsed = Date.parse(message.timestamp)
    if (parsed > latestTimestamp) {
      latestTimestamp = parsed
      latest = message
    }
  }

  return latest
}

function overrideSessionId<T extends SessionMessage>(
  message: T,
  sessionId: string,
): T {
  if (!('session_id' in message)) {
    return message
  }
  return {
    ...message,
    session_id: sessionId,
  } as T
}

async function appendJsonlEntry(filePath: string, entry: unknown): Promise<void> {
  await appendFile(filePath, `${JSON.stringify(entry)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
}

function matchesMessageSelector(
  message: TranscriptMessage,
  selector: string,
): boolean {
  if (message.uuid === selector) return true
  return message.type === 'assistant' && message.message.id === selector
}

function deriveFirstPrompt(transcript: TranscriptMessage[]): string {
  const firstUserMessage = transcript.find(
    (message): message is Extract<TranscriptMessage, { type: 'user' }> =>
      message.type === 'user',
  )
  const content = firstUserMessage?.message?.content
  if (!content) return 'Branched conversation'

  const raw =
    typeof content === 'string'
      ? content
      : content.find(
          (block): block is { type: 'text'; text: string } =>
            block.type === 'text',
        )?.text

  if (!raw) return 'Branched conversation'

  return (
    raw.replace(/\s+/g, ' ').trim().slice(0, 100) || 'Branched conversation'
  )
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function buildDefaultForkTitle(
  baseName: string,
  dir?: string,
): Promise<string> {
  const normalizedBase = baseName.trim() || 'Branched conversation'
  const candidateName = `${normalizedBase} (Branch)`
  if (!dir) return candidateName

  const sessions = await listSessionsImpl({ dir })
  const existingTitles = sessions
    .map(session => session.customTitle?.trim())
    .filter((title): title is string => Boolean(title))
  const normalizedCandidate = candidateName.toLowerCase()

  if (!existingTitles.some(title => title.toLowerCase() === normalizedCandidate)) {
    return candidateName
  }

  const usedNumbers = new Set<number>([1])
  const pattern = new RegExp(
    `^${escapeRegExp(normalizedBase)} \\(Branch(?: (\\d+))?\\)$`,
  )

  for (const title of existingTitles) {
    const match = title.match(pattern)
    if (!match) continue
    usedNumbers.add(match[1] ? Number.parseInt(match[1], 10) : 1)
  }

  let nextNumber = 2
  while (usedNumbers.has(nextNumber)) {
    nextNumber++
  }

  return `${normalizedBase} (Branch ${nextNumber})`
}

function collectToolUseIds(transcript: TranscriptMessage[]): Set<string> {
  const toolUseIds = new Set<string>()

  for (const message of transcript) {
    if (message.type !== 'assistant' || !Array.isArray(message.message.content)) {
      continue
    }

    for (const block of message.message.content) {
      if (block.type === 'tool_use' && typeof block.id === 'string') {
        toolUseIds.add(block.id)
      }
    }
  }

  return toolUseIds
}

function remapOptionalUuid(
  maybeUuid: UUID | null | undefined,
  uuidMap: Map<UUID, UUID>,
): UUID | null | undefined {
  if (maybeUuid === undefined) return undefined
  if (maybeUuid === null) return null
  return uuidMap.get(maybeUuid) ?? null
}

function remapCompactMetadata(
  metadata: CompactMetadata | undefined,
  uuidMap: Map<UUID, UUID>,
): CompactMetadata | undefined {
  if (!metadata?.preservedSegment) {
    return metadata
  }

  const headUuid = uuidMap.get(metadata.preservedSegment.headUuid)
  const anchorUuid = uuidMap.get(metadata.preservedSegment.anchorUuid)
  const tailUuid = uuidMap.get(metadata.preservedSegment.tailUuid)

  if (!headUuid || !anchorUuid || !tailUuid) {
    const { preservedSegment: _preservedSegment, ...rest } = metadata
    return rest
  }

  return {
    ...metadata,
    preservedSegment: {
      headUuid,
      anchorUuid,
      tailUuid,
    },
  }
}

function remapTranscriptMessage(
  message: TranscriptMessage,
  sourceSessionId: UUID,
  targetSessionId: UUID,
  uuidMap: Map<UUID, UUID>,
): TranscriptMessage & {
  forkedFrom: { sessionId: UUID; messageUuid: UUID }
} {
  const remapped = {
    ...message,
    uuid: uuidMap.get(message.uuid)!,
    sessionId: targetSessionId,
    parentUuid: (remapOptionalUuid(message.parentUuid, uuidMap) ?? null) as
      | UUID
      | null,
    logicalParentUuid: remapOptionalUuid(message.logicalParentUuid, uuidMap),
    isSidechain: false,
    agentId: undefined,
    teamName: undefined,
    forkedFrom: {
      sessionId: sourceSessionId,
      messageUuid: message.uuid,
    },
  } as TranscriptMessage & {
    sourceToolAssistantUUID?: UUID
    compactMetadata?: CompactMetadata
    forkedFrom: { sessionId: UUID; messageUuid: UUID }
  }

  if (message.type === 'user' && message.sourceToolAssistantUUID) {
    remapped.sourceToolAssistantUUID =
      uuidMap.get(message.sourceToolAssistantUUID) ?? undefined
  }

  if (message.type === 'system' && message.subtype === 'compact_boundary') {
    remapped.compactMetadata = remapCompactMetadata(
      message.compactMetadata,
      uuidMap,
    )
  }

  return remapped
}
type HookInputFor<Name extends string> = Extract<HookInput, {
  hook_event_name: Name;
}>;
export type PreToolUseHookInput = HookInputFor<'PreToolUse'>;
export type PostToolUseHookInput = HookInputFor<'PostToolUse'>;
export type PostToolUseFailureHookInput = HookInputFor<'PostToolUseFailure'>;
export type PermissionDeniedHookInput = HookInputFor<'PermissionDenied'>;
export type NotificationHookInput = HookInputFor<'Notification'>;
export type PermissionRequestHookInput = HookInputFor<'PermissionRequest'>;
export type UserPromptSubmitHookInput = HookInputFor<'UserPromptSubmit'>;
export type SessionStartHookInput = HookInputFor<'SessionStart'>;
export type SessionEndHookInput = HookInputFor<'SessionEnd'>;
export type SetupHookInput = HookInputFor<'Setup'>;
export type StopHookInput = HookInputFor<'Stop'>;
export type StopFailureHookInput = HookInputFor<'StopFailure'>;
export type SubagentStartHookInput = HookInputFor<'SubagentStart'>;
export type SubagentStopHookInput = HookInputFor<'SubagentStop'>;
export type PreCompactHookInput = HookInputFor<'PreCompact'>;
export type PostCompactHookInput = HookInputFor<'PostCompact'>;
export type TeammateIdleHookInput = HookInputFor<'TeammateIdle'>;
export type TaskCreatedHookInput = HookInputFor<'TaskCreated'>;
export type TaskCompletedHookInput = HookInputFor<'TaskCompleted'>;
export type ElicitationHookInput = HookInputFor<'Elicitation'>;
export type ElicitationResultHookInput = HookInputFor<'ElicitationResult'>;
export type ConfigChangeHookInput = HookInputFor<'ConfigChange'>;
export type InstructionsLoadedHookInput = HookInputFor<'InstructionsLoaded'>;
export type CwdChangedHookInput = HookInputFor<'CwdChanged'>;
export type FileChangedHookInput = HookInputFor<'FileChanged'>;
export type WorktreeCreateHookInput = HookInputFor<'WorktreeCreate'>;
export type WorktreeRemoveHookInput = HookInputFor<'WorktreeRemove'>;

function isZodSchema(value: unknown): value is z.ZodType {
  return typeof value === 'object' && value !== null && '_zod' in value
}

function preserveInputSchemaDescriptions(schema: AnyZodRawShape): void {
  for (const field of Object.values(schema)) {
    if (!isZodSchema(field)) {
      continue
    }

    const description = field.description
    if (description && !z.globalRegistry.has(field)) {
      z.globalRegistry.add(field, { description })
    }
  }
}

export function tool<Schema extends AnyZodRawShape>(
  name: string,
  description: string,
  inputSchema: Schema,
  handler: (
    args: InferShape<Schema>,
    extra: unknown,
  ) => Promise<CallToolResult>,
  extras?: {
    annotations?: ToolAnnotations
    searchHint?: string
    alwaysLoad?: boolean
  },
): SdkMcpToolDefinition<Schema> {
  const metadata: Record<string, unknown> = {}
  if (extras?.searchHint) {
    metadata['anthropic/searchHint'] = extras.searchHint
  }
  if (extras?.alwaysLoad) {
    metadata['anthropic/alwaysLoad'] = true
  }

  return {
    name,
    description,
    inputSchema,
    handler,
    annotations: extras?.annotations,
    _meta: Object.keys(metadata).length > 0 ? metadata : undefined,
  }
}

type CreateSdkMcpServerOptions = {
  name: string
  version?: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools?: Array<SdkMcpToolDefinition<any>>
}

/**
 * Creates an MCP server instance that can be used with the SDK transport.
 * This allows SDK users to define custom tools that run in the same process.
 *
 * If your SDK MCP calls will run longer than 60s, override CLAUDE_CODE_STREAM_CLOSE_TIMEOUT
 */
export function createSdkMcpServer(
  options: CreateSdkMcpServerOptions,
): McpSdkServerConfigWithInstance {
  const instance = new McpServer(
    {
      name: options.name,
      version: options.version ?? '1.0.0',
    },
    {
      capabilities: {
        tools: options.tools ? {} : undefined,
      },
    },
  )

  for (const definition of options.tools ?? []) {
    preserveInputSchemaDescriptions(definition.inputSchema)
    instance.registerTool(
      definition.name,
      {
        description: definition.description,
        inputSchema: definition.inputSchema,
        annotations: definition.annotations,
        _meta: definition._meta,
      },
      definition.handler,
    )
  }

  return {
    type: 'sdk',
    name: options.name,
    instance,
  }
}

export class AbortError extends Error {}

/** @internal */
export function query(_params: {
  prompt: string | AsyncIterable<SDKUserMessage>
  options?: InternalOptions
}): InternalQuery
export function query(_params: {
  prompt: string | AsyncIterable<SDKUserMessage>
  options?: Options
}): Query
export function query(): Query {
  throw new Error('query is not implemented in the SDK')
}

/**
 * V2 API - UNSTABLE
 * Create a persistent session for multi-turn conversations.
 * @alpha
 */
export function unstable_v2_createSession(
  _options: SDKSessionOptions,
): SDKSession {
  throw new Error('unstable_v2_createSession is not implemented in the SDK')
}

/**
 * V2 API - UNSTABLE
 * Resume an existing session by ID.
 * @alpha
 */
export function unstable_v2_resumeSession(
  _sessionId: string,
  _options: SDKSessionOptions,
): SDKSession {
  throw new Error('unstable_v2_resumeSession is not implemented in the SDK')
}

// @[MODEL LAUNCH]: Update the example model ID in this docstring.
/**
 * V2 API - UNSTABLE
 * One-shot convenience function for single prompts.
 * @alpha
 *
 * @example
 * ```typescript
 * const result = await unstable_v2_prompt("What files are here?", {
 *   model: 'claude-sonnet-4-6'
 * })
 * ```
 */
export async function unstable_v2_prompt(
  _message: string,
  _options: SDKSessionOptions,
): Promise<SDKResultMessage> {
  throw new Error('unstable_v2_prompt is not implemented in the SDK')
}

/**
 * Reads a session's conversation messages from its JSONL transcript file.
 *
 * Parses the transcript, builds the conversation chain via parentUuid links,
 * and returns user/assistant messages in chronological order. Set
 * `includeSystemMessages: true` in options to also include system messages.
 *
 * @param sessionId - UUID of the session to read
 * @param options - Optional dir, limit, offset, and includeSystemMessages
 * @returns Array of messages, or empty array if session not found
 */
export async function getSessionMessages(
  sessionId: string,
  options?: GetSessionMessagesOptions,
): Promise<SessionMessage[]> {
  const normalizedSessionId = requireUuid(sessionId, 'sessionId')
  const optionRecord = getOptionRecord(options)
  const dir = getStringOption(optionRecord, 'dir')
  const limit = getNonNegativeIntegerOption(optionRecord, 'limit')
  const offset = getNonNegativeIntegerOption(optionRecord, 'offset') ?? 0
  const includeSystemMessages =
    getBooleanOption(optionRecord, 'includeSystemMessages') ?? false

  const resolved = await resolveSessionFilePath(normalizedSessionId, dir)
  if (!resolved) {
    return []
  }

  const [{ buildConversationChain, loadTranscriptFile, removeExtraFields }, { toSDKMessages }] =
    await Promise.all([
      import('../utils/sessionStorage.js'),
      import('../utils/messages/mappers.js'),
    ])

  const { leafUuids, messages } = await loadTranscriptFile(resolved.filePath)
  const leafMessage =
    findLatestByTimestamp(
      messages.values(),
      message => !message.isSidechain && leafUuids.has(message.uuid),
    ) ??
    findLatestByTimestamp(
      messages.values(),
      message =>
        !message.isSidechain &&
        (message.type === 'user' || message.type === 'assistant'),
    )

  if (!leafMessage) {
    return []
  }

  const transcript = buildConversationChain(messages, leafMessage)
  let sdkMessages = toSDKMessages(
    removeExtraFields(transcript) as unknown as Message[],
  ).map(message => overrideSessionId(message, normalizedSessionId))

  if (!includeSystemMessages) {
    sdkMessages = sdkMessages.filter(message => message.type !== 'system')
  }

  return (limit && limit > 0
    ? sdkMessages.slice(offset, offset + limit)
    : sdkMessages.slice(offset)) as SessionMessage[]
}

/**
 * List sessions with metadata.
 *
 * When `dir` is provided, returns sessions for that project directory
 * and its git worktrees. When omitted, returns sessions across all
 * projects.
 *
 * Use `limit` and `offset` for pagination.
 *
 * @example
 * ```typescript
 * // List sessions for a specific project
 * const sessions = await listSessions({ dir: '/path/to/project' })
 *
 * // Paginate
 * const page1 = await listSessions({ limit: 50 })
 * const page2 = await listSessions({ limit: 50, offset: 50 })
 * ```
 */
export async function listSessions(
  options?: ListSessionsOptions,
): Promise<SDKSessionInfo[]> {
  const optionRecord = getOptionRecord(options)
  return listSessionsImpl({
    dir: getStringOption(optionRecord, 'dir'),
    limit: getNonNegativeIntegerOption(optionRecord, 'limit'),
    offset: getNonNegativeIntegerOption(optionRecord, 'offset'),
    includeWorktrees: getBooleanOption(optionRecord, 'includeWorktrees'),
  })
}

/**
 * Reads metadata for a single session by ID. Unlike `listSessions`, this only
 * reads the single session file rather than every session in the project.
 * Returns undefined if the session file is not found, is a sidechain session,
 * or has no extractable summary.
 *
 * @param sessionId - UUID of the session
 * @param options - `{ dir?: string }` project path; omit to search all project directories
 */
export async function getSessionInfo(
  sessionId: string,
  options?: GetSessionInfoOptions,
): Promise<SDKSessionInfo | undefined> {
  const normalizedSessionId = requireUuid(sessionId, 'sessionId')
  const optionRecord = getOptionRecord(options)
  const resolved = await resolveSessionFilePath(
    normalizedSessionId,
    getStringOption(optionRecord, 'dir'),
  )
  if (!resolved) {
    return undefined
  }

  const lite = await readSessionLite(resolved.filePath)
  if (!lite) {
    return undefined
  }

  return parseSessionInfoFromLite(
    normalizedSessionId,
    lite,
    resolved.projectPath,
  ) ?? undefined
}

/**
 * Rename a session. Appends a custom-title entry to the session's JSONL file.
 * @param sessionId - UUID of the session
 * @param title - New title
 * @param options - `{ dir?: string }` project path; omit to search all projects
 */
export async function renameSession(
  sessionId: string,
  title: string,
  options?: SessionMutationOptions,
): Promise<void> {
  const normalizedSessionId = requireUuid(sessionId, 'sessionId')
  const optionRecord = getOptionRecord(options)
  const resolved = await resolveSessionFilePath(
    normalizedSessionId,
    getStringOption(optionRecord, 'dir'),
  )

  if (!resolved) {
    throw new Error(`Session ${normalizedSessionId} was not found`)
  }

  await appendJsonlEntry(resolved.filePath, {
    type: 'custom-title',
    customTitle: title,
    sessionId: normalizedSessionId,
  })
}

/**
 * Tag a session. Pass null to clear the tag.
 * @param sessionId - UUID of the session
 * @param tag - Tag string, or null to clear
 * @param options - `{ dir?: string }` project path; omit to search all projects
 */
export async function tagSession(
  sessionId: string,
  tag: string | null,
  options?: SessionMutationOptions,
): Promise<void> {
  const normalizedSessionId = requireUuid(sessionId, 'sessionId')
  const optionRecord = getOptionRecord(options)
  const resolved = await resolveSessionFilePath(
    normalizedSessionId,
    getStringOption(optionRecord, 'dir'),
  )

  if (!resolved) {
    throw new Error(`Session ${normalizedSessionId} was not found`)
  }

  await appendJsonlEntry(resolved.filePath, {
    type: 'tag',
    tag: tag ?? '',
    sessionId: normalizedSessionId,
  })
}

/**
 * Fork a session into a new branch with fresh UUIDs.
 *
 * Copies transcript messages from the source session into a new session file,
 * remapping every message UUID and preserving the parentUuid chain. Supports
 * `upToMessageId` for branching from a specific point in the conversation.
 *
 * Forked sessions start without undo history (file-history snapshots are not
 * copied).
 *
 * @param sessionId - UUID of the source session
 * @param options - `{ dir?, upToMessageId?, title? }`
 * @returns `{ sessionId }` — UUID of the new forked session
 */
export async function forkSession(
  sessionId: string,
  options?: ForkSessionOptions,
): Promise<ForkSessionResult> {
  const normalizedSessionId = requireUuid(sessionId, 'sessionId')
  const optionRecord = getOptionRecord(options)
  const dir = getStringOption(optionRecord, 'dir')
  const upToMessageId = getStringOption(optionRecord, 'upToMessageId')
  const providedTitle =
    typeof optionRecord.title === 'string' ? optionRecord.title : undefined

  const resolved = await resolveSessionFilePath(normalizedSessionId, dir)
  if (!resolved) {
    throw new Error(`Session ${normalizedSessionId} was not found`)
  }

  const [{ buildConversationChain, loadTranscriptFile }, sourceLite] =
    await Promise.all([
      import('../utils/sessionStorage.js'),
      readSessionLite(resolved.filePath),
    ])

  const { contentReplacements, leafUuids, messages } = await loadTranscriptFile(
    resolved.filePath,
  )
  const anchorMessage = upToMessageId
    ? findLatestByTimestamp(
        messages.values(),
        message =>
          !message.isSidechain &&
          matchesMessageSelector(message, upToMessageId),
      )
    : findLatestByTimestamp(
        messages.values(),
        message => !message.isSidechain && leafUuids.has(message.uuid),
      )

  if (!anchorMessage) {
    if (upToMessageId) {
      throw new Error(
        `Message ${upToMessageId} was not found in session ${normalizedSessionId}`,
      )
    }
    throw new Error(`Session ${normalizedSessionId} has no messages to fork`)
  }

  const transcript = buildConversationChain(messages, anchorMessage).filter(
    message => !message.isSidechain,
  )
  if (transcript.length === 0) {
    throw new Error(`Session ${normalizedSessionId} has no messages to fork`)
  }

  const forkSessionId = randomUUID() as UUID
  const targetFilePath = join(dirname(resolved.filePath), `${forkSessionId}.jsonl`)
  const uuidMap = new Map<UUID, UUID>()
  for (const message of transcript) {
    uuidMap.set(message.uuid, randomUUID() as UUID)
  }

  const forkedTranscript = transcript.map(message =>
    remapTranscriptMessage(
      message,
      normalizedSessionId,
      forkSessionId,
      uuidMap,
    ),
  )

  const toolUseIds = collectToolUseIds(transcript)
  const forkedReplacements = (
    contentReplacements.get(normalizedSessionId) ?? []
  ).filter(record => toolUseIds.has(record.toolUseId))

  const sourceInfo = sourceLite
    ? parseSessionInfoFromLite(normalizedSessionId, sourceLite, resolved.projectPath)
    : null
  const effectiveTitle =
    providedTitle ??
    (await buildDefaultForkTitle(
      sourceInfo?.customTitle ??
        sourceInfo?.summary ??
        sourceInfo?.firstPrompt ??
        deriveFirstPrompt(transcript),
      sourceInfo?.cwd ?? resolved.projectPath,
    ))

  const lines = forkedTranscript.map(message => JSON.stringify(message))
  if (forkedReplacements.length > 0) {
    lines.push(
      JSON.stringify({
        type: 'content-replacement',
        sessionId: forkSessionId,
        replacements: forkedReplacements,
      }),
    )
  }
  if (effectiveTitle !== undefined) {
    lines.push(
      JSON.stringify({
        type: 'custom-title',
        customTitle: effectiveTitle,
        sessionId: forkSessionId,
      }),
    )
  }

  await mkdir(dirname(targetFilePath), { recursive: true, mode: 0o700 })
  await writeFile(targetFilePath, `${lines.join('\n')}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  })

  return { sessionId: forkSessionId }
}

// ============================================================================
// Assistant daemon primitives (internal)
// ============================================================================

/**
 * A scheduled task from `<dir>/.claude/scheduled_tasks.json`.
 * @internal
 */
export type CronTask = {
  id: string
  cron: string
  prompt: string
  createdAt: number
  recurring?: boolean
}

/**
 * Cron scheduler tuning knobs (jitter + expiry). Sourced at runtime from the
 * `tengu_kairos_cron_config` GrowthBook config in CLI sessions; daemon hosts
 * pass this through `watchScheduledTasks({ getJitterConfig })` to get the
 * same tuning.
 * @internal
 */
export type CronJitterConfig = {
  recurringFrac: number
  recurringCapMs: number
  oneShotMaxMs: number
  oneShotFloorMs: number
  oneShotMinuteMod: number
  recurringMaxAgeMs: number
}

/**
 * Event yielded by `watchScheduledTasks()`.
 * @internal
 */
export type ScheduledTaskEvent =
  | { type: 'fire'; task: CronTask }
  | { type: 'missed'; tasks: CronTask[] }

/**
 * Handle returned by `watchScheduledTasks()`.
 * @internal
 */
export type ScheduledTasksHandle = {
  /** Async stream of fire/missed events. Drain with `for await`. */
  events(): AsyncGenerator<ScheduledTaskEvent>
  /**
   * Epoch ms of the soonest scheduled fire across all loaded tasks, or null
   * if nothing is scheduled. Useful for deciding whether to tear down an
   * idle agent subprocess or keep it warm for an imminent fire.
   */
  getNextFireTime(): number | null
}

type ScheduledTaskQueueWaiter<T> = {
  resolve: (result: IteratorResult<T>) => void
  reject: (error: unknown) => void
}

function createScheduledTaskEventQueue<T>() {
  const values: T[] = []
  const waiters: ScheduledTaskQueueWaiter<T>[] = []
  let closed = false
  let failure: unknown

  return {
    push(value: T): void {
      if (closed || failure !== undefined) return
      const waiter = waiters.shift()
      if (waiter) {
        waiter.resolve({ value, done: false })
        return
      }
      values.push(value)
    },
    fail(error: unknown): void {
      if (closed || failure !== undefined) return
      failure = error
      for (const waiter of waiters.splice(0)) {
        waiter.reject(error)
      }
    },
    close(): void {
      if (closed || failure !== undefined) return
      closed = true
      for (const waiter of waiters.splice(0)) {
        waiter.resolve({ value: undefined as T, done: true })
      }
    },
    async *events(): AsyncGenerator<T> {
      while (true) {
        if (values.length > 0) {
          yield values.shift()!
          continue
        }
        if (failure !== undefined) {
          throw failure
        }
        if (closed) {
          return
        }
        const next = await new Promise<IteratorResult<T>>((resolve, reject) => {
          waiters.push({ resolve, reject })
        })
        if (next.done) {
          return
        }
        yield next.value
      }
    },
  }
}

function toSdkCronTask(task: {
  id: string
  cron: string
  prompt: string
  createdAt: number
  recurring?: boolean
}): CronTask {
  return {
    id: task.id,
    cron: task.cron,
    prompt: task.prompt,
    createdAt: task.createdAt,
    ...(task.recurring ? { recurring: true } : {}),
  }
}

function hasCronString(task: { cron?: string }): task is {
  id: string
  cron: string
  prompt: string
  createdAt: number
  recurring?: boolean
} {
  return typeof task.cron === 'string'
}

/**
 * Watch `<dir>/.claude/scheduled_tasks.json` and yield events as tasks fire.
 *
 * Acquires the per-directory scheduler lock (PID-based liveness) so a REPL
 * session in the same dir won't double-fire. Releases the lock and closes
 * the file watcher when the signal aborts.
 *
 * - `fire` — a task whose cron schedule was met. One-shot tasks are already
 *   deleted from the file when this yields; recurring tasks are rescheduled
 *   (or deleted if aged out).
 * - `missed` — one-shot tasks whose window passed while the daemon was down.
 *   Yielded once on initial load; a background delete removes them from the
 *   file shortly after.
 *
 * Intended for daemon architectures that own the scheduler externally and
 * spawn the agent via `query()`; the agent subprocess (`-p` mode) does not
 * run its own scheduler.
 *
 * @internal
 */
export function watchScheduledTasks(opts: {
  dir: string
  signal: AbortSignal
  getJitterConfig?: () => CronJitterConfig
}): ScheduledTasksHandle {
  const queue = createScheduledTaskEventQueue<ScheduledTaskEvent>()
  let scheduler: import('../utils/cronScheduler.js').CronScheduler | null = null
  let disposed = false

  const teardown = () => {
    if (disposed) return
    disposed = true
    opts.signal.removeEventListener('abort', teardown)
    scheduler?.stop()
    queue.close()
  }

  if (opts.signal.aborted) {
    teardown()
  } else {
    opts.signal.addEventListener('abort', teardown, { once: true })
    void import('../utils/cronScheduler.js')
      .then(({ createCronScheduler }) => {
        if (disposed) return

        scheduler = createCronScheduler({
          dir: opts.dir,
          lockIdentity: `agent-sdk:${process.pid}`,
          onFire: () => {},
          onFireTask(task) {
            if (!hasCronString(task)) return
            queue.push({
              type: 'fire',
              task: toSdkCronTask(task),
            })
          },
          onMissed(tasks) {
            queue.push({
              type: 'missed',
              tasks: tasks.map(task => toSdkCronTask(task)),
            })
          },
          isLoading: () => false,
          getJitterConfig: opts.getJitterConfig,
        })

        if (disposed) {
          scheduler.stop()
          scheduler = null
          return
        }

        scheduler.start()
      })
      .catch(error => {
        opts.signal.removeEventListener('abort', teardown)
        queue.fail(error)
      })
  }

  return {
    events() {
      return queue.events()
    },
    getNextFireTime() {
      return scheduler?.getNextFireTime() ?? null
    },
  }
}

/**
 * Format missed one-shot tasks into a prompt that asks the model to confirm
 * with the user (via AskUserQuestion) before executing.
 * @internal
 */
export function buildMissedTaskNotification(missed: CronTask[]): string {
  return formatMissedTaskNotification(missed)
}

/**
 * A user message typed on claude.ai, extracted from the bridge WS.
 * @internal
 */
export type InboundPrompt = {
  content: string | unknown[]
  uuid?: string
}

/**
 * Options for connectRemoteControl.
 * @internal
 */
export type ConnectRemoteControlOptions = {
  dir: string
  name?: string
  workerType?: string
  branch?: string
  gitRepoUrl?: string | null
  getAccessToken: () => string | undefined
  baseUrl: string
  orgUUID: string
  model: string
}

/**
 * Handle returned by connectRemoteControl. Write query() yields in,
 * read inbound prompts out. See src/assistant/daemonBridge.ts for full
 * field documentation.
 * @internal
 */
export type RemoteControlHandle = {
  sessionUrl: string
  environmentId: string
  bridgeSessionId: string
  write(msg: SDKMessage): void
  sendResult(): void
  sendControlRequest(req: unknown): void
  sendControlResponse(res: unknown): void
  sendControlCancelRequest(requestId: string): void
  inboundPrompts(): AsyncGenerator<InboundPrompt>
  controlRequests(): AsyncGenerator<unknown>
  permissionResponses(): AsyncGenerator<unknown>
  onStateChange(
    cb: (
      state: 'ready' | 'connected' | 'reconnecting' | 'failed',
      detail?: string,
    ) => void,
  ): void
  teardown(): Promise<void>
}

/**
 * Hold a claude.ai remote-control bridge connection from a daemon process.
 *
 * The daemon owns the WebSocket in the PARENT process — if the agent
 * subprocess (spawned via `query()`) crashes, the daemon respawns it while
 * claude.ai keeps the same session. Contrast with `query.enableRemoteControl`
 * which puts the WS in the CHILD process (dies with the agent).
 *
 * Pipe `query()` yields through `write()` + `sendResult()`. Read
 * `inboundPrompts()` (user typed on claude.ai) into `query()`'s input
 * stream. Handle `controlRequests()` locally (interrupt → abort, set_model
 * → reconfigure).
 *
 * Skips the `tengu_ccr_bridge` gate and policy-limits check — @internal
 * caller is pre-entitled. OAuth is still required (env var or keychain).
 *
 * Returns null on no-OAuth or registration failure.
 *
 * @internal
 */
export async function connectRemoteControl(
  _opts: ConnectRemoteControlOptions,
): Promise<RemoteControlHandle | null> {
  throw new Error('not implemented')
}
