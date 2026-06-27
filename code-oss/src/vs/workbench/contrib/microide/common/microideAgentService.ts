/*---------------------------------------------------------------------------------------------
 *  Copyright (c) MicroIDE contributors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type {
	IMicroClaudeCapabilities,
	IMicroClaudeConfiguration,
	IMicroClaudePluginInfo,
	IMicroClaudeRuntimeSettings,
	IMicroClaudeSession,
	IMicroClaudeSkillInfo,
	IMicroClaudeSlashCommand,
	IMicroClaudeThinkingState,
	MicroClaudeEffortLevel,
	MicroClaudeFastModeState
} from '../../../../platform/microide/common/microClaudeProtocol.js';

export const MICROIDE_VIEW_CONTAINER_ID = 'workbench.view.microide';
export const MICROIDE_AGENT_PANEL_VIEW_ID = 'microide.agentPanel';

export const IMicroIDEAgentService = createDecorator<IMicroIDEAgentService>('microIDEAgentService');

export type MicroIDEAgentStatus = 'idle' | 'starting' | 'ready' | 'busy' | 'error';
export type MicroIDEAgentMessageRole = 'user' | 'assistant' | 'system' | 'tool';
export type MicroIDEAgentMessageState = 'complete' | 'streaming' | 'error';
export type MicroIDEAgentMessageKind = 'runReport';
export type MicroIDEAgentMode = 'agent' | 'multiAgent' | 'workflow';
export type MicroIDEPermissionState = 'pending' | 'approved' | 'denied' | 'cancelled' | 'error';
export type MicroIDEPermissionMode = 'ask' | 'auto' | 'fullAccess';
export type MicroIDEAgentEventSeverity = 'info' | 'warning' | 'error';
export type MicroIDEToolEffect = 'read' | 'edit' | 'command' | 'network' | 'memory' | 'other';
export type MicroIDETurnPhase = 'sending' | 'thinking' | 'waitingPermission' | 'runningTool' | 'summarizing' | 'done' | 'interrupted' | 'error';
export type MicroIDEEffortLevel = MicroClaudeEffortLevel;

export interface IMicroIDEAuthState {
	readonly isAuthenticated: boolean;
	readonly username: string | null;
	readonly displayName: string | null;
	readonly error: string | null;
}

export interface IMicroIDEAgentSessionTab {
	readonly id: string;
	readonly title: string;
	readonly customTitle?: string;
	readonly generatedTitle?: string;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly status: string;
	readonly model?: string | null;
	readonly summary?: string;
	readonly toolCount?: number;
	readonly commandCount?: number;
	readonly changedFileCount?: number;
	readonly permissionCount?: number;
	readonly closed?: boolean;
}

export interface IMicroIDEDiffLine {
	readonly kind: 'context' | 'added' | 'removed';
	readonly oldLine?: number;
	readonly newLine?: number;
	readonly text: string;
}

export interface IMicroIDEDiffHunk {
	readonly oldStart: number;
	readonly oldLines: number;
	readonly newStart: number;
	readonly newLines: number;
	readonly lines: readonly IMicroIDEDiffLine[];
}

export interface IMicroIDEDiffPreview {
	readonly filePath: string;
	readonly summary: string;
	readonly added: number;
	readonly removed: number;
	readonly isNewFile?: boolean;
	readonly originalContent?: string;
	readonly proposedContent?: string;
	readonly hunks: readonly IMicroIDEDiffHunk[];
}

export interface IMicroIDEAgentMessage {
	readonly id: string;
	readonly sessionId: string | null;
	readonly role: MicroIDEAgentMessageRole;
	readonly kind?: MicroIDEAgentMessageKind;
	readonly text: string;
	readonly createdAt: number;
	readonly state: MicroIDEAgentMessageState;
	readonly toolUseId?: string;
	readonly toolName?: string;
	readonly toolEffect?: MicroIDEToolEffect;
	readonly summary?: string;
	readonly path?: string;
	readonly command?: string;
	readonly input?: unknown;
	readonly output?: unknown;
	readonly isError?: boolean;
	readonly agentId?: string;
	readonly agentName?: string;
	readonly teamName?: string;
	readonly diff?: IMicroIDEDiffPreview;
	readonly attachments?: readonly IMicroIDEImageAttachment[];
	readonly fileContexts?: readonly IMicroIDEFileContextAttachment[];
}

export interface IMicroIDETodoItem {
	readonly id: string;
	readonly text: string;
	readonly status: string;
}

export interface IMicroIDEPermissionRequest {
	readonly id: string;
	readonly requestId: string;
	readonly sessionId: string | null;
	readonly toolName: string;
	readonly summary: string;
	readonly path?: string;
	readonly command?: string;
	readonly input?: unknown;
	readonly diff?: IMicroIDEDiffPreview;
	readonly raw?: unknown;
	readonly createdAt: number;
	readonly resolvedAt?: number;
	readonly state: MicroIDEPermissionState;
	readonly reason?: string;
}

export interface IMicroIDEAgentEvent {
	readonly id: string;
	readonly sessionId: string | null;
	readonly title: string;
	readonly detail?: string;
	readonly severity: MicroIDEAgentEventSeverity;
	readonly createdAt: number;
}

export interface IMicroIDETurnStatus {
	readonly sessionId: string | null;
	readonly phase: MicroIDETurnPhase;
	readonly startedAt: number;
	readonly updatedAt: number;
	readonly currentToolName?: string;
	readonly currentToolSummary?: string;
	readonly pendingPermissionCount: number;
}

export interface IMicroIDEModelRuntime {
	readonly thinkingEnabled: boolean;
	readonly thinking: IMicroClaudeThinkingState;
	readonly effort: MicroIDEEffortLevel;
	readonly appliedModel?: string | null;
	readonly fastModeState?: MicroClaudeFastModeState;
	readonly account?: Record<string, unknown> | null;
	readonly settings?: IMicroClaudeRuntimeSettings | null;
}

export interface IMicroIDEAgentTeamMember {
	readonly id: string;
	readonly name: string;
	readonly agentType?: string;
	readonly model?: string;
	readonly color?: string;
	readonly status: 'running' | 'idle' | 'stopped' | 'unknown';
	readonly backend?: string;
	readonly currentTaskIds?: readonly string[];
	readonly startedAt: number;
	readonly lastActivityAt: number;
}

export interface IMicroIDEAgentTeamTask {
	readonly id: string;
	readonly subject: string;
	readonly status: string;
	readonly owner?: string;
	readonly blockedBy?: readonly string[];
}

export interface IMicroIDEAgentTeamMessage {
	readonly id: string;
	readonly from?: string;
	readonly to?: string;
	readonly summary?: string;
	readonly text?: string;
	readonly createdAt: number;
}

export interface IMicroIDEAgentTeamState {
	readonly teamName: string | null;
	readonly teamFilePath?: string;
	readonly leadAgentId?: string;
	readonly status: 'inactive' | 'active' | 'deleting' | 'error';
	readonly members: readonly IMicroIDEAgentTeamMember[];
	readonly tasks: readonly IMicroIDEAgentTeamTask[];
	readonly messages: readonly IMicroIDEAgentTeamMessage[];
}

export interface IMicroIDEPluginCatalogState {
	readonly installed: readonly IMicroClaudePluginInfo[];
	readonly available: readonly IMicroClaudePluginInfo[];
	readonly refreshedAt: string | null;
}
export interface IMicroIDEAgentState {
	readonly auth: IMicroIDEAuthState;
	readonly status: MicroIDEAgentStatus;
	readonly engine: string | null;
	readonly engineDegraded: boolean;
	readonly protocolVersion: string | null;
	readonly session: IMicroClaudeSession | null;
	readonly capabilities: IMicroClaudeCapabilities | null;
	readonly configuration: IMicroClaudeConfiguration | null;
	readonly slashCommands: readonly IMicroClaudeSlashCommand[];
	readonly skills: readonly IMicroClaudeSkillInfo[];
	readonly plugins: IMicroIDEPluginCatalogState;
	readonly selectedModel: string | null;
	readonly modelRuntime: IMicroIDEModelRuntime;
	readonly agentMode: MicroIDEAgentMode;
	readonly team: IMicroIDEAgentTeamState;
	readonly permissionMode: MicroIDEPermissionMode;
	readonly error: string | null;
	readonly activeSessionId: string | null;
	readonly turnStatus: IMicroIDETurnStatus | null;
	readonly sessions: readonly IMicroIDEAgentSessionTab[];
	readonly messages: readonly IMicroIDEAgentMessage[];
	readonly permissions: readonly IMicroIDEPermissionRequest[];
	readonly todos: readonly IMicroIDETodoItem[];
	readonly events: readonly IMicroIDEAgentEvent[];
}

export interface IMicroIDEImageAttachment {
	readonly id: string;
	readonly name: string;
	readonly mediaType: string;
	/** base64-encoded image data without the data: URI prefix */
	readonly data: string;
}

export interface IMicroIDEFileContextAttachment {
	readonly id: string;
	readonly label: string;
	readonly path: string;
	readonly source: 'activeEditor' | 'mention';
	readonly enabled: boolean;
	readonly selectionLineCount?: number;
	readonly selectedTextLength?: number;
	readonly selectionRanges?: readonly IMicroIDEFileContextRange[];
}

export interface IMicroIDEFileContextRange {
	readonly startLineNumber: number;
	readonly endLineNumber: number;
}

export interface IMicroIDECustomModel {
	readonly id: string;
	readonly label: string;
	readonly baseUrl?: string;
	/** Stored locally so custom endpoints work across restarts; never echoed in events. */
	readonly apiKey?: string;
}

export interface IMicroIDEAgentService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeState: Event<IMicroIDEAgentState>;

	getState(): IMicroIDEAgentState;
	getPendingPermissionCount(): number;
	signIn(username: string, password: string): Promise<void>;
	signOut(): Promise<void>;
	ensureReady(): Promise<void>;
	refreshCapabilities(): Promise<void>;
	setSelectedModel(modelId: string): Promise<void>;
	setThinkingEnabled(enabled: boolean): Promise<void>;
	setEffort(effort: MicroIDEEffortLevel): Promise<void>;
	refreshModelRuntime(): Promise<void>;
	addCustomModel(model: IMicroIDECustomModel): Promise<void>;
	removeCustomModel(modelId: string): Promise<void>;
	setAgentMode(mode: MicroIDEAgentMode): Promise<void>;
	setPermissionMode(mode: MicroIDEPermissionMode): Promise<void>;
	startNewSession(): Promise<void>;
	renameSession(sessionId: string, title: string): Promise<void>;
	closeSession(sessionId: string): Promise<void>;
	switchSession(sessionId: string): Promise<void>;
	sendPrompt(prompt: string, attachments?: readonly IMicroIDEImageAttachment[], context?: readonly IMicroIDEFileContextAttachment[]): Promise<void>;
	installPlugin(pluginId: string): Promise<void>;
	uninstallPlugin(pluginId: string): Promise<void>;
	improvePrompt(prompt: string, mode: 'working' | 'coding', context?: readonly IMicroIDEFileContextAttachment[]): Promise<string>;
	cancelActiveSession(): Promise<void>;
	approvePermission(requestId: string, reason?: string, updatedInput?: unknown, updatedPermissions?: readonly unknown[]): Promise<void>;
	approveAllEditsForSession(requestId: string): Promise<void>;
	approvePermissionForProject(requestId: string): Promise<void>;
	denyPermission(requestId: string, reason?: string): Promise<void>;
	clearMessages(): void;
	clearResolvedPermissions(): void;
}
