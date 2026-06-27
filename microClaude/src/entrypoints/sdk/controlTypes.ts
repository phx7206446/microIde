import type { z } from 'zod/v4'
import type {
  SDKMessage,
  SDKPartialAssistantMessage as CoreSDKPartialAssistantMessage,
  SDKPostTurnSummaryMessage,
  SDKStreamlinedTextMessage,
  SDKStreamlinedToolUseSummaryMessage,
  SDKUserMessage,
} from './coreTypes.js'

type ControlSchemas = typeof import('./controlSchemas.js')

type LazySchemaFactory<Schema extends z.ZodTypeAny = z.ZodTypeAny> = (
  ...args: never[]
) => Schema

type InferLazySchema<Factory extends LazySchemaFactory> = z.infer<
  ReturnType<Factory>
>

export type SDKHookCallbackMatcher = InferLazySchema<
  ControlSchemas['SDKHookCallbackMatcherSchema']
>

export type SDKControlInitializeRequest = InferLazySchema<
  ControlSchemas['SDKControlInitializeRequestSchema']
>
export type SDKControlInitializeResponse = InferLazySchema<
  ControlSchemas['SDKControlInitializeResponseSchema']
>
export type SDKControlInterruptRequest = InferLazySchema<
  ControlSchemas['SDKControlInterruptRequestSchema']
>
export type SDKControlPermissionRequest = InferLazySchema<
  ControlSchemas['SDKControlPermissionRequestSchema']
>
export type SDKControlSetPermissionModeRequest = InferLazySchema<
  ControlSchemas['SDKControlSetPermissionModeRequestSchema']
>
export type SDKControlSetModelRequest = InferLazySchema<
  ControlSchemas['SDKControlSetModelRequestSchema']
>
export type SDKControlSetMaxThinkingTokensRequest = InferLazySchema<
  ControlSchemas['SDKControlSetMaxThinkingTokensRequestSchema']
>
export type SDKControlMcpStatusRequest = InferLazySchema<
  ControlSchemas['SDKControlMcpStatusRequestSchema']
>
export type SDKControlMcpStatusResponse = InferLazySchema<
  ControlSchemas['SDKControlMcpStatusResponseSchema']
>
export type SDKControlGetContextUsageRequest = InferLazySchema<
  ControlSchemas['SDKControlGetContextUsageRequestSchema']
>
export type SDKControlGetContextUsageResponse = InferLazySchema<
  ControlSchemas['SDKControlGetContextUsageResponseSchema']
>
export type SDKControlRewindFilesRequest = InferLazySchema<
  ControlSchemas['SDKControlRewindFilesRequestSchema']
>
export type SDKControlRewindFilesResponse = InferLazySchema<
  ControlSchemas['SDKControlRewindFilesResponseSchema']
>
export type SDKControlCancelAsyncMessageRequest = InferLazySchema<
  ControlSchemas['SDKControlCancelAsyncMessageRequestSchema']
>
export type SDKControlCancelAsyncMessageResponse = InferLazySchema<
  ControlSchemas['SDKControlCancelAsyncMessageResponseSchema']
>
export type SDKControlSeedReadStateRequest = InferLazySchema<
  ControlSchemas['SDKControlSeedReadStateRequestSchema']
>
export type SDKHookCallbackRequest = InferLazySchema<
  ControlSchemas['SDKHookCallbackRequestSchema']
>
export type SDKControlMcpMessageRequest = InferLazySchema<
  ControlSchemas['SDKControlMcpMessageRequestSchema']
>
export type SDKControlMcpSetServersRequest = InferLazySchema<
  ControlSchemas['SDKControlMcpSetServersRequestSchema']
>
export type SDKControlMcpSetServersResponse = InferLazySchema<
  ControlSchemas['SDKControlMcpSetServersResponseSchema']
>
export type SDKControlReloadPluginsRequest = InferLazySchema<
  ControlSchemas['SDKControlReloadPluginsRequestSchema']
>
export type SDKControlReloadPluginsResponse = InferLazySchema<
  ControlSchemas['SDKControlReloadPluginsResponseSchema']
>
export type SDKControlMcpReconnectRequest = InferLazySchema<
  ControlSchemas['SDKControlMcpReconnectRequestSchema']
>
export type SDKControlMcpToggleRequest = InferLazySchema<
  ControlSchemas['SDKControlMcpToggleRequestSchema']
>
export type SDKControlEndSessionRequest = InferLazySchema<
  ControlSchemas['SDKControlEndSessionRequestSchema']
>
export type SDKControlChannelEnableRequest = InferLazySchema<
  ControlSchemas['SDKControlChannelEnableRequestSchema']
>
export type SDKControlMcpAuthenticateRequest = InferLazySchema<
  ControlSchemas['SDKControlMcpAuthenticateRequestSchema']
>
export type SDKControlMcpOauthCallbackUrlRequest = InferLazySchema<
  ControlSchemas['SDKControlMcpOauthCallbackUrlRequestSchema']
>
export type SDKControlMcpClearAuthRequest = InferLazySchema<
  ControlSchemas['SDKControlMcpClearAuthRequestSchema']
>
export type SDKControlStopTaskRequest = InferLazySchema<
  ControlSchemas['SDKControlStopTaskRequestSchema']
>
export type SDKControlApplyFlagSettingsRequest = InferLazySchema<
  ControlSchemas['SDKControlApplyFlagSettingsRequestSchema']
>
export type SDKControlGetSettingsRequest = InferLazySchema<
  ControlSchemas['SDKControlGetSettingsRequestSchema']
>
export type SDKControlGetSettingsResponse = InferLazySchema<
  ControlSchemas['SDKControlGetSettingsResponseSchema']
>
export type SDKControlGenerateSessionTitleRequest = InferLazySchema<
  ControlSchemas['SDKControlGenerateSessionTitleRequestSchema']
>
export type SDKControlSideQuestionRequest = InferLazySchema<
  ControlSchemas['SDKControlSideQuestionRequestSchema']
>
export type SDKControlSetProactiveRequest = InferLazySchema<
  ControlSchemas['SDKControlSetProactiveRequestSchema']
>
export type SDKControlRemoteControlRequest = InferLazySchema<
  ControlSchemas['SDKControlRemoteControlRequestSchema']
>
export type SDKControlElicitationRequest = InferLazySchema<
  ControlSchemas['SDKControlElicitationRequestSchema']
>
export type SDKControlElicitationResponse = InferLazySchema<
  ControlSchemas['SDKControlElicitationResponseSchema']
>

export type SDKControlRequestInner = InferLazySchema<
  ControlSchemas['SDKControlRequestInnerSchema']
>
export type SDKControlRequest = InferLazySchema<
  ControlSchemas['SDKControlRequestSchema']
>
export type ControlResponse = InferLazySchema<
  ControlSchemas['ControlResponseSchema']
>
export type ControlErrorResponse = InferLazySchema<
  ControlSchemas['ControlErrorResponseSchema']
>
export type SDKControlResponse = InferLazySchema<
  ControlSchemas['SDKControlResponseSchema']
>
export type SDKControlCancelRequest = InferLazySchema<
  ControlSchemas['SDKControlCancelRequestSchema']
>
export type SDKKeepAliveMessage = InferLazySchema<
  ControlSchemas['SDKKeepAliveMessageSchema']
>
export type SDKUpdateEnvironmentVariablesMessage = InferLazySchema<
  ControlSchemas['SDKUpdateEnvironmentVariablesMessageSchema']
>
export type SDKPartialAssistantMessage = CoreSDKPartialAssistantMessage
export type StdoutMessage =
  | SDKMessage
  | SDKStreamlinedTextMessage
  | SDKStreamlinedToolUseSummaryMessage
  | SDKPostTurnSummaryMessage
  | SDKControlResponse
  | SDKControlRequest
  | SDKControlCancelRequest
  | SDKKeepAliveMessage
export type StdinMessage =
  | SDKUserMessage
  | SDKControlRequest
  | SDKControlResponse
  | SDKKeepAliveMessage
  | SDKUpdateEnvironmentVariablesMessage
