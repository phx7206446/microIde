import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type {
  CallToolResult,
  ElicitRequestParams,
  ElicitResult,
  ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js'
import type { z } from 'zod/v4'
import type { HookCallbackMatcher } from '../../types/hooks.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type {
  AccountInfo,
  AgentDefinition,
  AgentInfo,
  HookEvent,
  McpHttpServerConfig,
  McpSdkServerConfig,
  McpSetServersResult,
  McpSSEServerConfig,
  McpServerStatus,
  McpStdioServerConfig,
  ModelInfo,
  OutputFormat,
  PermissionMode,
  RewindFilesResult,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
  SdkBeta,
  SdkPluginConfig,
  SettingSource,
  SlashCommand,
  ThinkingConfig,
} from './coreTypes.generated.js'
import type {
  SDKControlGetContextUsageResponse,
  SDKControlInitializeResponse,
  SDKControlReloadPluginsResponse,
} from './controlTypes.js'
import type { SandboxSettings } from './coreTypes.js'
import type { Settings } from './settingsTypes.generated.js'

export type AnyZodRawShape = z.ZodRawShape
export type InferShape<Schema extends AnyZodRawShape> = z.infer<
  z.ZodObject<Schema>
>
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type ToolName = string
export type CanUseTool = CanUseToolFn

export type ToolConfig = {
  askUserQuestion?: {
    previewFormat?: 'markdown' | 'html'
  }
}

export type SDKSystemPrompt =
  | string
  | {
      type: 'preset'
      preset: 'claude_code'
      append?: string
      excludeDynamicSections?: boolean
    }

export type ElicitationRequest = ElicitRequestParams
export type ElicitationResult = ElicitResult
export type OnElicitation = (
  request: ElicitationRequest,
  options: { signal: AbortSignal },
) => Promise<ElicitationResult>

export type McpSdkServerConfigWithInstance = McpSdkServerConfig & {
  instance: McpServer
}

export type McpServerConfig =
  | McpStdioServerConfig
  | McpSSEServerConfig
  | McpHttpServerConfig
  | McpSdkServerConfigWithInstance

export interface Query extends AsyncGenerator<SDKMessage, void, unknown> {
  interrupt(): Promise<void>
  setPermissionMode(mode: PermissionMode): Promise<void>
  setModel(model?: string): Promise<void>
  setMaxThinkingTokens(maxThinkingTokens: number | null): Promise<void>
  applyFlagSettings(settings: Settings): Promise<void>
  initializationResult(): Promise<SDKControlInitializeResponse>
  supportedCommands(): Promise<SlashCommand[]>
  supportedModels(): Promise<ModelInfo[]>
  supportedAgents(): Promise<AgentInfo[]>
  mcpServerStatus(): Promise<McpServerStatus[]>
  getContextUsage(): Promise<SDKControlGetContextUsageResponse>
  reloadPlugins(): Promise<SDKControlReloadPluginsResponse>
  accountInfo(): Promise<AccountInfo>
  rewindFiles(
    userMessageId: string,
    options?: { dryRun?: boolean },
  ): Promise<RewindFilesResult>
  seedReadState(path: string, mtime: number): Promise<void>
  reconnectMcpServer(serverName: string): Promise<void>
  toggleMcpServer(serverName: string, enabled: boolean): Promise<void>
  setMcpServers(
    servers: Record<string, McpServerConfig>,
  ): Promise<McpSetServersResult>
  streamInput(stream: AsyncIterable<SDKUserMessage>): Promise<void>
  stopTask(taskId: string): Promise<void>
  close(): void
}

export type InternalQuery = Query

export type Options = {
  abortController?: AbortController
  additionalDirectories?: string[]
  agent?: string
  agents?: Record<string, AgentDefinition>
  allowedTools?: string[]
  canUseTool?: CanUseTool
  continue?: boolean
  cwd?: string
  disallowedTools?: string[]
  tools?: ToolName[] | { type: 'preset'; preset: 'claude_code' }
  env?: Record<string, string | undefined>
  executable?: 'bun' | 'deno' | 'node'
  executableArgs?: string[]
  extraArgs?: Record<string, string | null>
  fallbackModel?: string
  enableFileCheckpointing?: boolean
  toolConfig?: ToolConfig
  forkSession?: boolean
  betas?: SdkBeta[]
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>
  onElicitation?: OnElicitation
  persistSession?: boolean
  includeHookEvents?: boolean
  includePartialMessages?: boolean
  thinking?: ThinkingConfig
  effort?: EffortLevel
  maxThinkingTokens?: number
  maxTurns?: number
  maxBudgetUsd?: number
  taskBudget?: {
    total: number
  }
  mcpServers?: Record<string, McpServerConfig>
  model?: string
  outputFormat?: OutputFormat
  pathToClaudeCodeExecutable?: string
  permissionMode?: PermissionMode
  allowDangerouslySkipPermissions?: boolean
  permissionPromptToolName?: string
  plugins?: SdkPluginConfig[]
  promptSuggestions?: boolean
  agentProgressSummaries?: boolean
  resume?: string
  sessionId?: string
  resumeSessionAt?: string
  sandbox?: SandboxSettings
  settings?: string | Settings
  settingSources?: SettingSource[]
  debug?: boolean
  debugFile?: string
  stderr?: (data: string) => void
  strictMcpConfig?: boolean
  systemPrompt?: SDKSystemPrompt
  workload?: string
}

export type InternalOptions = Options

export interface SDKSession {
  readonly sessionId: string
  send(message: string | SDKUserMessage): Promise<void>
  stream(): AsyncGenerator<SDKMessage, void>
  close(): void
  [Symbol.asyncDispose](): Promise<void>
}

export type SDKSessionOptions = {
  model: string
  pathToClaudeCodeExecutable?: string
  executable?: 'node' | 'bun'
  executableArgs?: string[]
  env?: Record<string, string | undefined>
  allowedTools?: string[]
  disallowedTools?: string[]
  canUseTool?: CanUseTool
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>
  permissionMode?: PermissionMode
}

export type SessionMutationOptions = {
  dir?: string
}
export type ListSessionsOptions = {
  dir?: string
  limit?: number
  offset?: number
  includeWorktrees?: boolean
}
export type GetSessionInfoOptions = {
  dir?: string
}
export type GetSessionMessagesOptions = {
  dir?: string
  limit?: number
  offset?: number
  includeSystemMessages?: boolean
}
export type ForkSessionOptions = {
  dir?: string
  upToMessageId?: string
  title?: string
}
export type ForkSessionResult = {
  sessionId: string
}
export type SdkMcpToolDefinition<
  Schema extends AnyZodRawShape = AnyZodRawShape,
> = {
  name: string
  description: string
  inputSchema: Schema
  annotations?: ToolAnnotations
  _meta?: Record<string, unknown>
  handler: (
    args: InferShape<Schema>,
    extra: unknown,
  ) => Promise<CallToolResult>
}
export type SDKOneShotPrompt = (
  message: string,
  options: SDKSessionOptions,
) => Promise<SDKResultMessage>
