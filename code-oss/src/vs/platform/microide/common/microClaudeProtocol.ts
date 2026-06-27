/*---------------------------------------------------------------------------------------------
 *  Copyright (c) MicroIDE contributors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

export const MICRO_CLAUDE_PROTOCOL_VERSION = '1.0.0';

export type MicroClaudeJsonRpcId = string | number | null;

export interface IMicroClaudeJsonRpcRequest<TParams = unknown> {
	readonly jsonrpc: '2.0';
	readonly id: MicroClaudeJsonRpcId;
	readonly method: MicroClaudeMethod;
	readonly params?: TParams;
}

export interface IMicroClaudeJsonRpcResponse<TResult = unknown> {
	readonly jsonrpc: '2.0';
	readonly id: MicroClaudeJsonRpcId;
	readonly result?: TResult;
	readonly error?: IMicroClaudeJsonRpcError;
}

export interface IMicroClaudeJsonRpcError {
	readonly code: number;
	readonly message: string;
	readonly data?: unknown;
}

export type MicroClaudeMethod =
	| 'sidecar.ping'
	| 'sidecar.getCapabilities'
	| 'sidecar.getConfiguration'
	| 'commands.list'
	| 'skills.list'
	| 'plugins.list'
	| 'plugins.install'
	| 'plugins.uninstall'
	| 'prompt.improve'
	| 'models.list'
	| 'model.set'
	| 'thinking.set'
	| 'effort.set'
	| 'modelSettings.get'
	| 'session.start'
	| 'session.resume'
	| 'session.cancel'
	| 'session.dispose'
	| 'message.send'
	| 'message.continue'
	| 'permission.resolve';

export type MicroClaudeEventName =
	| 'assistant.delta'
	| 'assistant.message'
	| 'todo.update'
	| 'tool.request'
	| 'tool.result'
	| 'team.created'
	| 'team.teammate.started'
	| 'team.message.sent'
	| 'team.message.received'
	| 'team.deleted'
	| 'team.task.updated'
	| 'task.started'
	| 'task.progress'
	| 'task.updated'
	| 'task.notification'
	| 'permission.request'
	| 'permission.cancel'
	| 'engine.started'
	| 'engine.stdout'
	| 'engine.stderr'
	| 'session.result'
	| 'session.title'
	| 'session.status'
	| 'session.error';

export interface IMicroClaudeSidecarEvent<TPayload = unknown> {
	readonly type: 'event';
	readonly sessionId: string | null;
	readonly event: MicroClaudeEventName;
	readonly payload: TPayload;
}

export interface IMicroClaudeCapabilities {
	readonly chat: boolean;
	readonly agent: boolean;
	readonly applyPatch: boolean;
	readonly terminal: boolean;
	readonly mcp: boolean;
	readonly repoWiki: boolean;
	readonly memory: boolean;
	readonly streamingEvents: boolean;
	readonly cancellation: boolean;
	readonly permissionResolution: boolean;
	readonly agentTeams?: boolean;
}

export interface IMicroClaudeManifest {
	readonly name: string;
	readonly version: string;
	readonly engineVersion?: string;
	readonly protocolVersion: string;
	readonly platform: string;
	readonly entry: string;
	readonly runtime: {
		readonly type: string;
		readonly version: string;
	};
	readonly capabilities: IMicroClaudeCapabilities;
}

export interface IMicroClaudeModelConfiguration {
	readonly id: string;
	readonly label: string;
	readonly provider?: string;
	readonly baseUrl?: string;
	readonly description?: string;
	/**
	 * Model context window in tokens. When omitted, the workbench falls back to a
	 * conservative model-name estimate for the context meter.
	 */
	readonly contextWindow?: number;
	/**
	 * Optional compute/billing multiplier surfaced in the model picker (e.g. 1.0, 1.6, 0.3).
	 * Undefined when the engine does not report a weight for this model.
	 */
	readonly weight?: number;
	/**
	 * Optional tier label grouping models by capability/cost (e.g. "极致", "性能", "经济").
	 */
	readonly tier?: string;
	/**
	 * True when the model was added by the user via custom configuration rather than shipped defaults.
	 */
	readonly custom?: boolean;
	readonly supportsEffort?: boolean;
	readonly supportedEffortLevels?: readonly MicroClaudeEffortLevel[];
	readonly supportsAdaptiveThinking?: boolean;
	readonly supportsFastMode?: boolean;
	readonly supportsAutoMode?: boolean;
}

export type MicroClaudeEffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultracode';
export type MicroClaudeEffortValue = 'auto' | MicroClaudeEffortLevel;
export type MicroClaudeFastModeState = 'off' | 'cooldown' | 'on';

export interface IMicroClaudeThinkingState {
	readonly enabled: boolean;
	readonly mode: 'auto' | 'budget' | 'disabled';
	readonly maxThinkingTokens?: number | null;
}

export interface IMicroClaudeAppliedModelSettings {
	readonly model?: string;
	readonly effort?: MicroClaudeEffortValue | null;
	readonly thinking?: IMicroClaudeThinkingState;
}

export interface IMicroClaudeRuntimeSettingsSource {
	readonly source: string;
	readonly settings: Record<string, unknown>;
}

export interface IMicroClaudeRuntimeSettings {
	readonly effective: Record<string, unknown>;
	readonly sources: readonly IMicroClaudeRuntimeSettingsSource[];
	readonly applied?: IMicroClaudeAppliedModelSettings;
}

export interface IMicroClaudeConfiguration {
	readonly configPath?: string;
	readonly defaultModel: string;
	readonly selectedModel: string;
	readonly baseUrl?: string;
	readonly models: readonly IMicroClaudeModelConfiguration[];
}

export interface IMicroClaudeSession {
	readonly id: string;
	readonly workspace: string | null;
	readonly userDataDir: string | null;
	readonly projectDataDir: string | null;
	readonly model?: string | null;
	readonly mode: string;
	readonly autoApprove: boolean;
	readonly permissionMode?: string | null;
	readonly status: string;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface IMicroClaudePingResult {
	readonly status: 'ok';
	readonly pid: number;
	readonly uptimeMs: number;
	readonly protocolVersion: string;
	readonly engine: string;
	readonly configuration?: IMicroClaudeConfiguration;
	readonly manifest: IMicroClaudeManifest;
}

export interface IMicroClaudeCapabilitiesResult {
	readonly protocolVersion: string;
	readonly engine: string;
	readonly capabilities: IMicroClaudeCapabilities;
	readonly configuration?: IMicroClaudeConfiguration;
}

export interface IMicroClaudeSlashCommand {
	readonly name: string;
	readonly description: string;
	readonly argumentHint?: string;
}

export interface IMicroClaudeListCommandsParams {
	readonly workspace?: string;
	readonly model?: string;
}

export interface IMicroClaudeListCommandsResult {
	readonly commands: readonly IMicroClaudeSlashCommand[];
	readonly engine: string;
	readonly refreshedAt: string;
}

export type MicroClaudeCatalogItemStatus = 'installed' | 'available';

export interface IMicroClaudeSkillInfo {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly source?: string;
	readonly origin?: string;
	readonly path?: string;
	readonly status?: MicroClaudeCatalogItemStatus;
}

export interface IMicroClaudePluginInfo {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly marketplace?: string;
	readonly source?: string;
	readonly path?: string;
	readonly version?: string;
	readonly status: MicroClaudeCatalogItemStatus;
	readonly actionCommand?: string;
}

export interface IMicroClaudeListSkillsParams {
	readonly workspace?: string;
	readonly model?: string;
}

export interface IMicroClaudeListSkillsResult {
	readonly skills: readonly IMicroClaudeSkillInfo[];
	readonly engine: string;
	readonly refreshedAt: string;
}

export interface IMicroClaudeListPluginsParams {
	readonly workspace?: string;
	readonly model?: string;
}

export interface IMicroClaudeListPluginsResult {
	readonly installed: readonly IMicroClaudePluginInfo[];
	readonly available: readonly IMicroClaudePluginInfo[];
	readonly engine: string;
	readonly refreshedAt: string;
}

export interface IMicroClaudeInstallPluginParams {
	readonly plugin: string;
	readonly scope?: 'user' | 'project' | 'local';
	readonly workspace?: string;
}

export interface IMicroClaudeInstallPluginResult {
	readonly plugin: IMicroClaudePluginInfo;
	readonly installed: readonly IMicroClaudePluginInfo[];
	readonly available: readonly IMicroClaudePluginInfo[];
	readonly engine: string;
	readonly refreshedAt: string;
	readonly message?: string;
}
export interface IMicroClaudeUninstallPluginParams {
	readonly plugin: string;
	readonly workspace?: string;
}

export interface IMicroClaudeUninstallPluginResult {
	readonly plugin: string;
	readonly installed: readonly IMicroClaudePluginInfo[];
	readonly available: readonly IMicroClaudePluginInfo[];
	readonly engine: string;
	readonly refreshedAt: string;
	readonly message?: string;
}

export interface IMicroClaudeImprovePromptContextItem {
	readonly path: string;
	readonly label?: string;
	readonly source?: 'activeEditor' | 'mention' | string;
	readonly selectionLineCount?: number;
	readonly selectedTextLength?: number;
	readonly selectionRanges?: readonly { readonly startLineNumber: number; readonly endLineNumber: number }[];
}

export interface IMicroClaudeImprovePromptParams {
	readonly prompt?: string;
	readonly mode?: 'working' | 'coding' | string;
	readonly workspace?: string;
	readonly model?: string;
	readonly baseUrl?: string;
	readonly apiKey?: string;
	readonly context?: readonly IMicroClaudeImprovePromptContextItem[];
}

export interface IMicroClaudeImprovePromptResult {
	readonly prompt: string;
	readonly model?: string;
	readonly engine: string;
	readonly fallback?: boolean;
	readonly refreshedAt: string;
}

export interface IMicroClaudeListModelsParams {
	readonly workspace?: string;
	readonly model?: string;
}

export interface IMicroClaudeListModelsResult {
	readonly models: readonly IMicroClaudeModelConfiguration[];
	readonly fastModeState?: MicroClaudeFastModeState;
	readonly account?: Record<string, unknown>;
	readonly outputStyle?: string;
	readonly availableOutputStyles?: readonly string[];
	readonly engine: string;
	readonly refreshedAt: string;
}

export interface IMicroClaudeSetModelParams {
	readonly sessionId: string;
	readonly model?: string;
}

export interface IMicroClaudeSetModelResult {
	readonly sessionId: string;
	readonly requestedModel?: string;
	readonly model: string;
	readonly settings?: IMicroClaudeRuntimeSettings;
	readonly session?: IMicroClaudeSession;
}

export interface IMicroClaudeSetThinkingParams {
	readonly sessionId: string;
	readonly enabled?: boolean;
	readonly maxThinkingTokens?: number | null;
}

export interface IMicroClaudeSetThinkingResult {
	readonly sessionId: string;
	readonly thinking: IMicroClaudeThinkingState;
}

export interface IMicroClaudeSetEffortParams {
	readonly sessionId: string;
	readonly effort: MicroClaudeEffortValue;
}

export interface IMicroClaudeSetEffortResult {
	readonly sessionId: string;
	readonly effort: MicroClaudeEffortValue;
	readonly applied?: IMicroClaudeAppliedModelSettings;
}

export interface IMicroClaudeModelSettingsParams {
	readonly sessionId: string;
}

export interface IMicroClaudeModelSettingsResult extends IMicroClaudeRuntimeSettings {
	readonly sessionId: string;
}

export interface IMicroClaudeStartSessionParams {
	readonly sessionId?: string;
	readonly workspace?: string;
	readonly userDataDir?: string;
	readonly projectDataDir?: string;
	readonly model?: string;
	readonly mode?: 'agent' | 'multiAgent' | 'workflow' | 'ask' | 'spec' | string;
	readonly autoApprove?: boolean;
	readonly permissionMode?: string;
	/**
	 * Optional per-session endpoint override for user-defined custom models. When set, the
	 * sidecar exports these into the engine environment (ANTHROPIC_BASE_URL / token) so the
	 * turn targets the user's own provider without persisting secrets in shipped config.
	 */
	readonly baseUrl?: string;
	readonly apiKey?: string;
}

export interface IMicroClaudeStartSessionResult {
	readonly session: IMicroClaudeSession;
	readonly resumed?: boolean;
}

export interface IMicroClaudeTextContentBlock {
	readonly type: 'text';
	readonly text: string;
}

export interface IMicroClaudeImageContentBlock {
	readonly type: 'image';
	readonly source: {
		readonly type: 'base64';
		readonly media_type: string;
		readonly data: string;
	};
}

export type IMicroClaudeContentBlock = IMicroClaudeTextContentBlock | IMicroClaudeImageContentBlock;

export interface IMicroClaudeSendMessageParams {
	readonly sessionId: string;
	readonly prompt?: string;
	readonly text?: string;
	readonly model?: string;
	readonly mode?: 'agent' | 'multiAgent' | 'workflow' | 'ask' | 'spec' | string;
	readonly content?: readonly IMicroClaudeContentBlock[];
	readonly messages?: readonly unknown[];
}

export interface IMicroClaudeSendMessageResult {
	readonly accepted: boolean;
	readonly sessionId: string;
}

export interface IMicroClaudeCancelSessionResult {
	readonly cancelled: boolean;
	readonly sessionId: string;
}

export interface IMicroClaudeDisposeSessionResult {
	readonly disposed: boolean;
	readonly sessionId: string;
}

export interface IMicroClaudeResolvePermissionParams {
	readonly requestId: string;
	readonly approve: boolean;
	readonly reason?: string;
	readonly updatedInput?: unknown;
	readonly updatedPermissions?: readonly unknown[];
}

export interface IMicroClaudeResolvePermissionResult {
	readonly resolved: boolean;
	readonly requestId?: string;
	readonly reason?: string;
}

export function isMicroClaudeSidecarEvent(value: unknown): value is IMicroClaudeSidecarEvent {
	const candidate = value as Partial<IMicroClaudeSidecarEvent> | undefined;
	return Boolean(candidate && candidate.type === 'event' && typeof candidate.event === 'string');
}

export function isMicroClaudeJsonRpcResponse(value: unknown): value is IMicroClaudeJsonRpcResponse {
	const candidate = value as Partial<IMicroClaudeJsonRpcResponse> | undefined;
	return Boolean(candidate && candidate.jsonrpc === '2.0' && Object.prototype.hasOwnProperty.call(candidate, 'id'));
}
