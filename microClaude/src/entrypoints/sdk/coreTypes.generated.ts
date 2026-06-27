import type { z } from 'zod/v4'
import type { BetaMessage, BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import type { NonNullableUsage } from './sdkUtilityTypes.js'

type CoreSchemas = typeof import('./coreSchemas.js')

type LazySchemaFactory<Schema extends z.ZodTypeAny = z.ZodTypeAny> = (
  ...args: never[]
) => Schema

type InferLazySchema<Factory extends LazySchemaFactory> = z.infer<
  ReturnType<Factory>
>

type APIUserMessage = {
  role: 'user'
  content: string | ContentBlockParam[]
}

type APIAssistantMessage = BetaMessage

export type ModelUsage = InferLazySchema<CoreSchemas['ModelUsageSchema']>

export type OutputFormatType = InferLazySchema<
  CoreSchemas['OutputFormatTypeSchema']
>
export type BaseOutputFormat = InferLazySchema<
  CoreSchemas['BaseOutputFormatSchema']
>
export type JsonSchemaOutputFormat = InferLazySchema<
  CoreSchemas['JsonSchemaOutputFormatSchema']
>
export type OutputFormat = InferLazySchema<CoreSchemas['OutputFormatSchema']>

export type ApiKeySource = InferLazySchema<CoreSchemas['ApiKeySourceSchema']>
export type ConfigScope = InferLazySchema<CoreSchemas['ConfigScopeSchema']>
export type SdkBeta = InferLazySchema<CoreSchemas['SdkBetaSchema']>
export type ThinkingAdaptive = InferLazySchema<
  CoreSchemas['ThinkingAdaptiveSchema']
>
export type ThinkingEnabled = InferLazySchema<
  CoreSchemas['ThinkingEnabledSchema']
>
export type ThinkingDisabled = InferLazySchema<
  CoreSchemas['ThinkingDisabledSchema']
>
export type ThinkingConfig = InferLazySchema<
  CoreSchemas['ThinkingConfigSchema']
>

export type McpStdioServerConfig = InferLazySchema<
  CoreSchemas['McpStdioServerConfigSchema']
>
export type McpSSEServerConfig = InferLazySchema<
  CoreSchemas['McpSSEServerConfigSchema']
>
export type McpHttpServerConfig = InferLazySchema<
  CoreSchemas['McpHttpServerConfigSchema']
>
export type McpSdkServerConfig = InferLazySchema<
  CoreSchemas['McpSdkServerConfigSchema']
>
export type McpServerConfigForProcessTransport = InferLazySchema<
  CoreSchemas['McpServerConfigForProcessTransportSchema']
>
export type McpClaudeAIProxyServerConfig = InferLazySchema<
  CoreSchemas['McpClaudeAIProxyServerConfigSchema']
>
export type McpServerStatusConfig = InferLazySchema<
  CoreSchemas['McpServerStatusConfigSchema']
>
export type McpServerStatus = InferLazySchema<
  CoreSchemas['McpServerStatusSchema']
>
export type McpSetServersResult = InferLazySchema<
  CoreSchemas['McpSetServersResultSchema']
>

export type PermissionUpdateDestination = InferLazySchema<
  CoreSchemas['PermissionUpdateDestinationSchema']
>
export type PermissionBehavior = InferLazySchema<
  CoreSchemas['PermissionBehaviorSchema']
>
export type PermissionRuleValue = InferLazySchema<
  CoreSchemas['PermissionRuleValueSchema']
>
export type PermissionUpdate = InferLazySchema<
  CoreSchemas['PermissionUpdateSchema']
>
export type PermissionDecisionClassification = InferLazySchema<
  CoreSchemas['PermissionDecisionClassificationSchema']
>
export type PermissionResult = InferLazySchema<
  CoreSchemas['PermissionResultSchema']
>
export type PermissionMode = InferLazySchema<
  CoreSchemas['PermissionModeSchema']
>

export type HookEvent = InferLazySchema<CoreSchemas['HookEventSchema']>
export type HookInput = InferLazySchema<CoreSchemas['HookInputSchema']>
export type AsyncHookJSONOutput = InferLazySchema<
  CoreSchemas['AsyncHookJSONOutputSchema']
>
export type SyncHookJSONOutput = InferLazySchema<
  CoreSchemas['SyncHookJSONOutputSchema']
>
export type HookJSONOutput = InferLazySchema<
  CoreSchemas['HookJSONOutputSchema']
>
export type PromptRequestOption = InferLazySchema<
  CoreSchemas['PromptRequestOptionSchema']
>
export type PromptRequest = InferLazySchema<CoreSchemas['PromptRequestSchema']>
export type PromptResponse = InferLazySchema<
  CoreSchemas['PromptResponseSchema']
>

export type SlashCommand = InferLazySchema<CoreSchemas['SlashCommandSchema']>
export type AgentInfo = InferLazySchema<CoreSchemas['AgentInfoSchema']>
export type ModelInfo = InferLazySchema<CoreSchemas['ModelInfoSchema']>
export type AccountInfo = InferLazySchema<CoreSchemas['AccountInfoSchema']>
export type AgentMcpServerSpec = InferLazySchema<
  CoreSchemas['AgentMcpServerSpecSchema']
>
export type AgentDefinition = InferLazySchema<
  CoreSchemas['AgentDefinitionSchema']
>
export type SettingSource = InferLazySchema<CoreSchemas['SettingSourceSchema']>
export type SdkPluginConfig = InferLazySchema<
  CoreSchemas['SdkPluginConfigSchema']
>

export type RewindFilesResult = InferLazySchema<
  CoreSchemas['RewindFilesResultSchema']
>

export type SDKAssistantMessageError = InferLazySchema<
  CoreSchemas['SDKAssistantMessageErrorSchema']
>
export type SDKStatus = InferLazySchema<CoreSchemas['SDKStatusSchema']>

export type SDKUserMessage = Omit<
  InferLazySchema<CoreSchemas['SDKUserMessageSchema']>,
  'message'
> & {
  message: APIUserMessage
}

export type SDKUserMessageReplay = Omit<
  InferLazySchema<CoreSchemas['SDKUserMessageReplaySchema']>,
  'message'
> & {
  message: APIUserMessage
}

export type SDKRateLimitInfo = InferLazySchema<
  CoreSchemas['SDKRateLimitInfoSchema']
>

export type SDKAssistantMessage = Omit<
  InferLazySchema<CoreSchemas['SDKAssistantMessageSchema']>,
  'message'
> & {
  message: APIAssistantMessage
}

export type SDKRateLimitEvent = InferLazySchema<
  CoreSchemas['SDKRateLimitEventSchema']
>
export type SDKStreamlinedTextMessage = InferLazySchema<
  CoreSchemas['SDKStreamlinedTextMessageSchema']
>
export type SDKStreamlinedToolUseSummaryMessage = InferLazySchema<
  CoreSchemas['SDKStreamlinedToolUseSummaryMessageSchema']
>
export type SDKPermissionDenial = InferLazySchema<
  CoreSchemas['SDKPermissionDenialSchema']
>

export type SDKResultSuccess = Omit<
  InferLazySchema<CoreSchemas['SDKResultSuccessSchema']>,
  'usage'
> & {
  usage: NonNullableUsage
}

export type SDKResultError = Omit<
  InferLazySchema<CoreSchemas['SDKResultErrorSchema']>,
  'usage'
> & {
  usage: NonNullableUsage
}

export type SDKResultMessage = SDKResultSuccess | SDKResultError

export type SDKSystemMessage = InferLazySchema<
  CoreSchemas['SDKSystemMessageSchema']
>

export type SDKPartialAssistantMessage = Omit<
  InferLazySchema<CoreSchemas['SDKPartialAssistantMessageSchema']>,
  'event'
> & {
  event: BetaRawMessageStreamEvent
}

export type SDKCompactBoundaryMessage = InferLazySchema<
  CoreSchemas['SDKCompactBoundaryMessageSchema']
>
export type SDKStatusMessage = InferLazySchema<
  CoreSchemas['SDKStatusMessageSchema']
>
export type SDKPostTurnSummaryMessage = InferLazySchema<
  CoreSchemas['SDKPostTurnSummaryMessageSchema']
>
export type SDKAPIRetryMessage = InferLazySchema<
  CoreSchemas['SDKAPIRetryMessageSchema']
>
export type SDKLocalCommandOutputMessage = InferLazySchema<
  CoreSchemas['SDKLocalCommandOutputMessageSchema']
>
export type SDKHookStartedMessage = InferLazySchema<
  CoreSchemas['SDKHookStartedMessageSchema']
>
export type SDKHookProgressMessage = InferLazySchema<
  CoreSchemas['SDKHookProgressMessageSchema']
>
export type SDKHookResponseMessage = InferLazySchema<
  CoreSchemas['SDKHookResponseMessageSchema']
>
export type SDKToolProgressMessage = InferLazySchema<
  CoreSchemas['SDKToolProgressMessageSchema']
>
export type SDKAuthStatusMessage = InferLazySchema<
  CoreSchemas['SDKAuthStatusMessageSchema']
>
export type SDKFilesPersistedEvent = InferLazySchema<
  CoreSchemas['SDKFilesPersistedEventSchema']
>
export type SDKTaskNotificationMessage = InferLazySchema<
  CoreSchemas['SDKTaskNotificationMessageSchema']
>
export type SDKTaskStartedMessage = InferLazySchema<
  CoreSchemas['SDKTaskStartedMessageSchema']
>
export type SDKSessionStateChangedMessage = InferLazySchema<
  CoreSchemas['SDKSessionStateChangedMessageSchema']
>
export type SDKTaskProgressMessage = InferLazySchema<
  CoreSchemas['SDKTaskProgressMessageSchema']
>
export type SDKTaskUpdatedMessage = InferLazySchema<
  CoreSchemas['SDKTaskUpdatedMessageSchema']
>
export type SDKToolUseSummaryMessage = InferLazySchema<
  CoreSchemas['SDKToolUseSummaryMessageSchema']
>
export type SDKElicitationCompleteMessage = InferLazySchema<
  CoreSchemas['SDKElicitationCompleteMessageSchema']
>
export type SDKPromptSuggestionMessage = InferLazySchema<
  CoreSchemas['SDKPromptSuggestionMessageSchema']
>

export type SDKMessage =
  | SDKAssistantMessage
  | SDKUserMessage
  | SDKUserMessageReplay
  | SDKResultMessage
  | SDKSystemMessage
  | SDKPartialAssistantMessage
  | SDKCompactBoundaryMessage
  | SDKStatusMessage
  | SDKAPIRetryMessage
  | SDKLocalCommandOutputMessage
  | SDKHookStartedMessage
  | SDKHookProgressMessage
  | SDKHookResponseMessage
  | SDKToolProgressMessage
  | SDKAuthStatusMessage
  | SDKTaskNotificationMessage
  | SDKTaskStartedMessage
  | SDKTaskProgressMessage
  | SDKTaskUpdatedMessage
  | SDKSessionStateChangedMessage
  | SDKFilesPersistedEvent
  | SDKToolUseSummaryMessage
  | SDKRateLimitEvent
  | SDKElicitationCompleteMessage
  | SDKPromptSuggestionMessage

export type SDKSessionInfo = InferLazySchema<CoreSchemas['SDKSessionInfoSchema']>
export type FastModeState = InferLazySchema<CoreSchemas['FastModeStateSchema']>

export type SessionMessage = SDKMessage

export type ExitReason = InferLazySchema<CoreSchemas['ExitReasonSchema']>
