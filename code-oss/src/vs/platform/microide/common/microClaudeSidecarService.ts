/*---------------------------------------------------------------------------------------------
 *  Copyright (c) MicroIDE contributors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import type {
	IMicroClaudeCancelSessionResult,
	IMicroClaudeCapabilitiesResult,
	IMicroClaudeConfiguration,
	IMicroClaudeImprovePromptParams,
	IMicroClaudeImprovePromptResult,
	IMicroClaudeInstallPluginParams,
	IMicroClaudeInstallPluginResult,
	IMicroClaudeUninstallPluginParams,
	IMicroClaudeUninstallPluginResult,
	IMicroClaudeDisposeSessionResult,
	IMicroClaudeListCommandsParams,
	IMicroClaudeListCommandsResult,
	IMicroClaudeListPluginsParams,
	IMicroClaudeListPluginsResult,
	IMicroClaudeListSkillsParams,
	IMicroClaudeListSkillsResult,
	IMicroClaudeListModelsParams,
	IMicroClaudeListModelsResult,
	IMicroClaudeModelSettingsParams,
	IMicroClaudeModelSettingsResult,
	IMicroClaudePingResult,
	IMicroClaudeResolvePermissionParams,
	IMicroClaudeResolvePermissionResult,
	IMicroClaudeSendMessageParams,
	IMicroClaudeSendMessageResult,
	IMicroClaudeSetEffortParams,
	IMicroClaudeSetEffortResult,
	IMicroClaudeSetModelParams,
	IMicroClaudeSetModelResult,
	IMicroClaudeSetThinkingParams,
	IMicroClaudeSetThinkingResult,
	IMicroClaudeSidecarEvent,
	IMicroClaudeStartSessionParams,
	IMicroClaudeStartSessionResult
} from './microClaudeProtocol.js';

export const MicroClaudeSidecarChannelName = 'microClaudeSidecar';

export const IMicroClaudeSidecarService = createDecorator<IMicroClaudeSidecarService>('microClaudeSidecarService');

export interface IMicroClaudeSidecarService {
	readonly _serviceBrand: undefined;

	readonly onDidEmitEvent: Event<IMicroClaudeSidecarEvent>;

	ping(): Promise<IMicroClaudePingResult>;
	getCapabilities(): Promise<IMicroClaudeCapabilitiesResult>;
	getConfiguration(): Promise<IMicroClaudeConfiguration>;
	listCommands(params?: IMicroClaudeListCommandsParams): Promise<IMicroClaudeListCommandsResult>;
	listSkills(params?: IMicroClaudeListSkillsParams): Promise<IMicroClaudeListSkillsResult>;
	listPlugins(params?: IMicroClaudeListPluginsParams): Promise<IMicroClaudeListPluginsResult>;
	installPlugin(params: IMicroClaudeInstallPluginParams): Promise<IMicroClaudeInstallPluginResult>;
	uninstallPlugin(params: IMicroClaudeUninstallPluginParams): Promise<IMicroClaudeUninstallPluginResult>;
	improvePrompt(params: IMicroClaudeImprovePromptParams): Promise<IMicroClaudeImprovePromptResult>;
	listModels(params?: IMicroClaudeListModelsParams): Promise<IMicroClaudeListModelsResult>;
	setModel(params: IMicroClaudeSetModelParams): Promise<IMicroClaudeSetModelResult>;
	setThinking(params: IMicroClaudeSetThinkingParams): Promise<IMicroClaudeSetThinkingResult>;
	setEffort(params: IMicroClaudeSetEffortParams): Promise<IMicroClaudeSetEffortResult>;
	getModelSettings(params: IMicroClaudeModelSettingsParams): Promise<IMicroClaudeModelSettingsResult>;
	startSession(params: IMicroClaudeStartSessionParams): Promise<IMicroClaudeStartSessionResult>;
	resumeSession(params: IMicroClaudeStartSessionParams & { readonly sessionId: string }): Promise<IMicroClaudeStartSessionResult>;
	sendMessage(params: IMicroClaudeSendMessageParams): Promise<IMicroClaudeSendMessageResult>;
	cancelSession(sessionId: string): Promise<IMicroClaudeCancelSessionResult>;
	disposeSession(sessionId: string): Promise<IMicroClaudeDisposeSessionResult>;
	resolvePermission(params: IMicroClaudeResolvePermissionParams): Promise<IMicroClaudeResolvePermissionResult>;
}
