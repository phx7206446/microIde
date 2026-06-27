/*---------------------------------------------------------------------------------------------
 *  Copyright (c) MicroIDE contributors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { localize } from '../../../../nls.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import type {
	IMicroClaudeConfiguration,
	IMicroClaudeContentBlock,
	IMicroClaudeImprovePromptContextItem,
	IMicroClaudeListModelsResult,
	IMicroClaudeModelConfiguration,
	IMicroClaudePluginInfo,
	IMicroClaudeRuntimeSettings,
	IMicroClaudeSession,
	IMicroClaudeSidecarEvent,
	IMicroClaudeSkillInfo,
	IMicroClaudeSlashCommand,
	MicroClaudeEffortValue
} from '../../../../platform/microide/common/microClaudeProtocol.js';
import { IMicroClaudeSidecarService } from '../../../../platform/microide/common/microClaudeSidecarService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import {
	IMicroIDEAgentService,
	type IMicroIDEAuthState,
	type IMicroIDEAgentEvent,
	type IMicroIDEAgentMessage,
	type IMicroIDEAgentSessionTab,
	type IMicroIDEAgentState,
	type IMicroIDECustomModel,
	type IMicroIDEDiffHunk,
	type IMicroIDEDiffPreview,
	type IMicroIDEFileContextAttachment,
	type IMicroIDEImageAttachment,
	type IMicroIDEModelRuntime,
	type IMicroIDEPermissionRequest,
	type IMicroIDEAgentTeamMessage,
	type IMicroIDEAgentTeamMember,
	type IMicroIDEAgentTeamState,
	type IMicroIDEAgentTeamTask,
	type IMicroIDETodoItem,
	type MicroIDEAgentEventSeverity,
	type MicroIDEAgentMessageState,
	type MicroIDEEffortLevel,
	type MicroIDEAgentMode,
	type MicroIDEToolEffect,
	type MicroIDETurnPhase,
	type MicroIDEPermissionMode,
	type MicroIDEAgentStatus,
	type MicroIDEPermissionState
} from '../common/microideAgentService.js';

const MAX_MESSAGES = 250;
const MAX_EVENTS = 120;
const MAX_PERMISSIONS = 100;
const MAX_SESSIONS = 12;
const STORAGE_KEY = 'microide.agent.sessions.v1';
const CUSTOM_MODELS_STORAGE_KEY = 'microide.agent.customModels.v1';
const ALLOW_RULES_STORAGE_KEY = 'microide.agent.allowRules.v1';
const MAX_PERSISTED_MESSAGES_PER_SESSION = 200;
const DEFAULT_THINKING_STATE = { enabled: true, mode: 'auto' as const, maxThinkingTokens: null };
const DEFAULT_MODEL_RUNTIME: IMicroIDEModelRuntime = {
	thinkingEnabled: true,
	thinking: DEFAULT_THINKING_STATE,
	effort: 'high',
	fastModeState: 'off',
	account: null,
	settings: null
};
const DEFAULT_TEAM_STATE: IMicroIDEAgentTeamState = {
	teamName: null,
	status: 'inactive',
	members: [],
	tasks: [],
	messages: []
};

interface IPersistedAgentState {
	readonly tabs: IMicroIDEAgentSessionTab[];
	readonly sessions?: IMicroClaudeSession[];
	readonly messages?: IMicroIDEAgentMessage[];
}

export class MicroIDEAgentService extends Disposable implements IMicroIDEAgentService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeState = this._register(new Emitter<IMicroIDEAgentState>());
	readonly onDidChangeState = this._onDidChangeState.event;

	private readonly messages: IMicroIDEAgentMessage[] = [];
	private readonly permissions: IMicroIDEPermissionRequest[] = [];
	private readonly todos: IMicroIDETodoItem[] = [];
	private readonly events: IMicroIDEAgentEvent[] = [];
	private readonly sessionStore = new Map<string, IMicroClaudeSession>();
	private readonly sessionTabs: IMicroIDEAgentSessionTab[] = [];
	private readonly activeAssistantMessageIds = new Map<string, string>();
	private readonly liveSessions = new Set<string>();
	private turnStatus: IMicroIDEAgentState['turnStatus'] = null;

	private auth: IMicroIDEAuthState = {
		isAuthenticated: true,
		username: 'local',
		displayName: 'MicroWorker Local',
		error: null
	};
	private status: MicroIDEAgentStatus = 'idle';
	private engine: string | null = null;
	private engineDegraded = false;
	private engineDegradedNotified = false;
	private protocolVersion: string | null = null;
	private session: IMicroIDEAgentState['session'] = null;
	private capabilities: IMicroIDEAgentState['capabilities'] = null;
	private configuration: IMicroClaudeConfiguration | null = null;
	private slashCommands: IMicroClaudeSlashCommand[] = [];
	private skills: IMicroClaudeSkillInfo[] = [];
	private plugins: { installed: IMicroClaudePluginInfo[]; available: IMicroClaudePluginInfo[]; refreshedAt: string | null } = { installed: [], available: [], refreshedAt: null };
	private modelRuntime: IMicroIDEModelRuntime = DEFAULT_MODEL_RUNTIME;
	private readonly customModels: IMicroIDECustomModel[] = [];
	private readonly allowRules = new Set<string>();
	private readonly sessionEditAllowAll = new Set<string>();
	private selectedModel: string | null = null;
	private agentMode: MicroIDEAgentMode = 'agent';
	private teamState: IMicroIDEAgentTeamState = DEFAULT_TEAM_STATE;
	private permissionMode: MicroIDEPermissionMode = 'auto';
	private error: string | null = null;
	private readyPromise: Promise<void> | undefined;
	private sequence = 0;

	constructor(
		@IMicroClaudeSidecarService private readonly microClaudeSidecarService: IMicroClaudeSidecarService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
		@IStorageService private readonly storageService: IStorageService
	) {
		super();

		this.restorePersistedState();
		this.restoreCustomModels();
		this.restoreAllowRules();
		this._register(this.microClaudeSidecarService.onDidEmitEvent(event => this.acceptSidecarEvent(event)));
		this._register(this.persistScheduler);
	}

	private readonly persistScheduler = new RunOnceScheduler(() => this.persistState(), 800);
	private readonly catalogRefreshScheduler = this._register(new RunOnceScheduler(() => void this.refreshCatalogsAfterTurn(), 600));

	getState(): IMicroIDEAgentState {
		const activeSessionId = this.session?.id ?? null;
		return {
			auth: this.auth,
			status: this.status,
			engine: this.engine,
			engineDegraded: this.engineDegraded,
			protocolVersion: this.protocolVersion,
			session: this.session,
			capabilities: this.capabilities,
			configuration: this.getMergedConfiguration(),
			slashCommands: this.slashCommands.slice(),
			skills: this.skills.slice(),
			plugins: {
				installed: this.plugins.installed.slice(),
				available: this.plugins.available.slice(),
				refreshedAt: this.plugins.refreshedAt
			},
			selectedModel: this.selectedModel,
			modelRuntime: this.modelRuntime,
			agentMode: this.agentMode,
			team: this.teamState,
			permissionMode: this.permissionMode,
			error: this.error,
			activeSessionId,
			turnStatus: this.turnStatus?.sessionId === activeSessionId ? this.turnStatus : null,
			sessions: this.getSessionTabs(),
			messages: filterSessionItems(this.messages, activeSessionId),
			permissions: filterSessionItems(this.permissions, activeSessionId),
			todos: this.todos.slice(),
			events: filterSessionItems(this.events, activeSessionId)
		};
	}

	getPendingPermissionCount(): number {
		return this.permissions.reduce((count, request) => count + (request.state === 'pending' ? 1 : 0), 0);
	}

	async signIn(username: string, _password: string): Promise<void> {
		const normalizedUsername = username.trim();

		this.auth = {
			isAuthenticated: true,
			username: normalizedUsername || 'local',
			displayName: normalizedUsername || 'MicroWorker Local',
			error: null
		};
		this.error = null;
		this.emitState();
		await this.ensureReady();
	}

	async signOut(): Promise<void> {
		this.auth = {
			isAuthenticated: true,
			username: 'local',
			displayName: 'MicroWorker Local',
			error: null
		};
		this.error = null;
		this.emitState();
		await this.ensureReady();
	}

	async ensureReady(): Promise<void> {
		if (this.configuration && this.engine && this.status !== 'error') {
			return;
		}

		if (this.readyPromise) {
			return this.readyPromise;
		}

		this.readyPromise = this.doEnsureReady().finally(() => {
			this.readyPromise = undefined;
		});

		return this.readyPromise;
	}

	private async doEnsureReady(): Promise<void> {
		this.setStatus('starting');

		try {
			const ping = await this.microClaudeSidecarService.ping();
			this.engine = ping.engine;
			this.protocolVersion = ping.protocolVersion;
			this.capabilities = ping.manifest.capabilities;
			this.configuration = ping.configuration ?? await this.microClaudeSidecarService.getConfiguration();
			this.selectedModel = this.normalizeSelectedModel(this.selectedModel ?? this.configuration.selectedModel ?? this.configuration.defaultModel);
			await this.doRefreshModelRuntime();
			await this.refreshSlashCommands();
			await this.refreshCatalogs();
			await this.ensureInitialVisibleSession();
			this.error = null;
			this.setStatus('ready');
			this.pushEvent('info', localize('microide.sidecarConnected', "microClaude sidecar connected"), `${ping.engine} / ${ping.protocolVersion}`, null);
			this.warnIfEngineDegraded(ping.engine);
		} catch (error) {
			this.error = toErrorMessage(error);
			this.setStatus('error');
			this.pushEvent('error', localize('microide.sidecarConnectFailed', "microClaude sidecar failed"), this.error, this.session?.id ?? null);
			throw error;
		}
	}

	private warnIfEngineDegraded(engine: string | null): void {
		const degraded = Boolean(engine) && engine !== 'microclaude';
		this.engineDegraded = degraded;
		if (degraded && !this.engineDegradedNotified) {
			this.engineDegradedNotified = true;
			this.pushEvent(
				'warning',
				localize('microide.engineDegraded', "microClaude engine unavailable �?running fallback engine '{0}'", engine ?? 'unknown'),
				localize('microide.engineDegradedDetail', "AI coding features are limited until the real microClaude CLI is available."),
				null
			);
		} else if (!degraded) {
			this.engineDegradedNotified = false;
		}
	}

	async refreshCapabilities(): Promise<void> {
		this.assertAuthenticated();
		try {
			const result = await this.microClaudeSidecarService.getCapabilities();
			this.engine = result.engine;
			this.protocolVersion = result.protocolVersion;
			this.capabilities = result.capabilities;
			this.configuration = result.configuration ?? await this.microClaudeSidecarService.getConfiguration();
			this.selectedModel = this.normalizeSelectedModel(this.selectedModel ?? this.configuration.selectedModel ?? this.configuration.defaultModel);
			await this.doRefreshModelRuntime();
			await this.refreshSlashCommands();
			await this.refreshCatalogs();
			this.error = null;
			this.setStatus(this.session ? this.status : 'ready');
			this.warnIfEngineDegraded(result.engine);
		} catch (error) {
			this.error = toErrorMessage(error);
			this.setStatus('error');
			throw error;
		}
	}

	private async refreshSlashCommands(): Promise<void> {
		try {
			const result = await this.microClaudeSidecarService.listCommands({
				workspace: this.getWorkspacePath(),
				model: this.selectedModel ?? undefined
			});
			this.slashCommands = normalizeSlashCommandList(result.commands ?? []);
		} catch (error) {
			this.slashCommands = [];
			const message = toErrorMessage(error);
			this.logService.warn(`[microide] failed to load slash commands: ${message}`);
			this.pushEvent('warning', localize('microide.slashCommandsLoadFailed', "Slash commands could not be loaded"), message, this.session?.id ?? null);
		}
	}

	private async refreshCatalogs(): Promise<void> {
		await Promise.all([this.refreshSkills(), this.refreshPlugins()]);
	}

	private async refreshSkills(): Promise<void> {
		try {
			const result = await this.microClaudeSidecarService.listSkills({
				workspace: this.getWorkspacePath(),
				model: this.selectedModel ?? undefined
			});
			this.skills = Array.isArray(result.skills) ? result.skills.slice() : [];
		} catch (error) {
			this.skills = [];
			this.logService.warn('[microide] failed to load skills: ' + toErrorMessage(error));
		}
	}

	private async refreshPlugins(): Promise<void> {
		try {
			const result = await this.microClaudeSidecarService.listPlugins({
				workspace: this.getWorkspacePath(),
				model: this.selectedModel ?? undefined
			});
			this.plugins = {
				installed: Array.isArray(result.installed) ? result.installed.slice() : [],
				available: Array.isArray(result.available) ? result.available.slice() : [],
				refreshedAt: result.refreshedAt ?? null
			};
		} catch (error) {
			this.plugins = { installed: [], available: [], refreshedAt: null };
			this.logService.warn('[microide] failed to load plugins: ' + toErrorMessage(error));
		}
	}

	private async refreshCatalogsAfterTurn(): Promise<void> {
		try {
			await this.refreshCatalogs();
			this.emitState();
		} catch (error) {
			this.logService.warn('[microide] failed to refresh catalogs after turn: ' + toErrorMessage(error));
		}
	}

	async refreshModelRuntime(): Promise<void> {
		this.assertAuthenticated();
		await this.ensureReady();
		await this.doRefreshModelRuntime();
		this.emitState();
	}

	private async doRefreshModelRuntime(): Promise<void> {
		await this.refreshModelCatalog();
		if (this.session) {
			await this.refreshActiveModelSettings();
		}
	}

	private async ensureInitialVisibleSession(): Promise<void> {
		if (this.session) {
			return;
		}

		// Keep restored task history in the sidebar, but always foreground a clean
		// WorkBuddy-style home session on startup so stale tool approvals do not
		// take over the first screen.
		const started = await this.startAgentSession({
			workspace: this.getWorkspacePath(),
			model: this.selectedModel ?? undefined
		});
		this.session = started.session;
		this.sessionStore.set(started.session.id, started.session);
		this.liveSessions.add(started.session.id);
		this.rememberSession(started.session);
	}

	private async refreshModelCatalog(): Promise<void> {
		try {
			const result = await this.microClaudeSidecarService.listModels({
				workspace: this.getWorkspacePath(),
				model: this.selectedModel ?? undefined
			});
			this.applyModelCatalog(result);
		} catch (error) {
			const message = toErrorMessage(error);
			this.logService.warn(`[microide] failed to load model catalog: ${message}`);
			this.pushEvent('warning', localize('microide.modelCatalogLoadFailed', "Model catalog could not be loaded"), message, this.session?.id ?? null);
		}
	}

	private async refreshActiveModelSettings(): Promise<void> {
		const sessionId = this.session?.id;
		if (!sessionId) {
			return;
		}

		try {
			const settings = await this.microClaudeSidecarService.getModelSettings({ sessionId });
			this.applyModelSettings(settings);
		} catch (error) {
			const message = toErrorMessage(error);
			this.logService.warn(`[microide] failed to load model settings: ${message}`);
		}
	}

	private applyModelCatalog(result: IMicroClaudeListModelsResult): void {
		if (result.models.length) {
			this.configuration = mergeRuntimeModels(this.configuration, result.models, this.selectedModel);
			this.selectedModel = this.normalizeSelectedModel(this.selectedModel ?? this.configuration.selectedModel ?? this.configuration.defaultModel);
		}

		this.modelRuntime = {
			...this.modelRuntime,
			fastModeState: result.fastModeState ?? this.modelRuntime.fastModeState,
			account: result.account ?? this.modelRuntime.account
		};
	}

	private applyModelSettings(settings: IMicroClaudeRuntimeSettings): void {
		const effort = normalizeRuntimeEffort(settings.applied?.effort);
		this.modelRuntime = {
			...this.modelRuntime,
			settings,
			appliedModel: settings.applied?.model ?? this.modelRuntime.appliedModel ?? null,
			...(effort ? { effort } : {})
		};
	}

	async setSelectedModel(modelId: string): Promise<void> {
		this.assertAuthenticated();
		await this.ensureReady();

		const normalized = this.normalizeSelectedModel(modelId);
		if (!normalized || normalized === this.selectedModel) {
			return;
		}

		if (this.status === 'busy') {
			throw new Error('Cannot change microClaude model while a turn is running');
		}

		const previousModel = this.selectedModel;
		this.selectedModel = normalized;
		this.emitState();

		try {
			if (!this.session) {
				await this.refreshSlashCommands();
				await this.refreshCatalogs();
				this.emitState();
				return;
			}

			if (this.modelEndpointChanged(previousModel, normalized)) {
				await this.restartActiveSessionForModel(normalized);
			} else {
				const result = await this.microClaudeSidecarService.setModel({
					sessionId: this.session.id,
					model: normalized
				});
				if (result.session) {
					this.session = result.session;
					this.sessionStore.set(result.session.id, result.session);
					this.updateSessionTab(result.session.id, {
						model: result.session.model ?? result.model ?? normalized,
						status: result.session.status,
						updatedAt: Date.now()
					});
				} else {
					this.updateActiveSessionModel(result.model ?? normalized);
				}
				if (result.settings) {
					this.applyModelSettings(result.settings);
				}
			}

			await this.refreshSlashCommands();
			await this.refreshCatalogs();
			this.error = null;
			this.setStatus(this.session?.status === 'busy' ? 'busy' : 'ready');
			this.pushEvent('info', localize('microide.modelChanged', "microClaude model changed"), normalized, this.session?.id ?? null);
		} catch (error) {
			this.selectedModel = previousModel;
			this.emitState();
			throw error;
		}
	}

	private async restartActiveSessionForModel(model: string): Promise<void> {
		if (!this.session) {
			return;
		}

		const previousSessionId = this.session.id;
		const workspace = this.session.workspace ?? this.getWorkspacePath();
		try {
			await this.microClaudeSidecarService.disposeSession(previousSessionId);
		} catch (error) {
			this.pushEvent('warning', localize('microide.sessionDisposeWarning', "Previous microClaude session could not be disposed"), toErrorMessage(error), previousSessionId);
		}
		const started = await this.startAgentSession({
			workspace: workspace ?? undefined,
			model
		});
		this.liveSessions.delete(previousSessionId);
		this.session = started.session;
		this.liveSessions.add(started.session.id);
		this.migrateSession(previousSessionId, started.session);
	}

	async setThinkingEnabled(enabled: boolean): Promise<void> {
		this.assertAuthenticated();
		await this.ensureReady();
		if (this.status === 'busy') {
			throw new Error('Cannot change microClaude thinking while a turn is running');
		}

		await this.ensureAgentSession();
		const sessionId = this.session?.id;
		if (!sessionId) {
			throw new Error('microClaude session is not ready');
		}

		const result = await this.microClaudeSidecarService.setThinking({
			sessionId,
			enabled,
			maxThinkingTokens: enabled ? null : 0
		});
		this.modelRuntime = {
			...this.modelRuntime,
			thinkingEnabled: result.thinking.enabled,
			thinking: result.thinking
		};
		this.pushEvent('info', localize('microide.thinkingChanged', "microClaude thinking changed"), result.thinking.enabled ? 'on' : 'off', sessionId);
		this.emitState();
	}

	async setEffort(effort: MicroIDEEffortLevel): Promise<void> {
		this.assertAuthenticated();
		await this.ensureReady();
		if (this.status === 'busy') {
			throw new Error('Cannot change microClaude effort while a turn is running');
		}

		const normalized = normalizeRuntimeEffort(effort);
		if (!normalized) {
			throw new Error('Invalid microClaude effort level');
		}

		await this.ensureAgentSession();
		const sessionId = this.session?.id;
		if (!sessionId) {
			throw new Error('microClaude session is not ready');
		}

		const result = await this.microClaudeSidecarService.setEffort({
			sessionId,
			effort: normalized
		});
		const appliedEffort = normalizeRuntimeEffort(result.applied?.effort) ?? normalizeRuntimeEffort(result.effort) ?? normalized;
		this.modelRuntime = {
			...this.modelRuntime,
			effort: appliedEffort,
			appliedModel: result.applied?.model ?? this.modelRuntime.appliedModel ?? null
		};
		this.pushEvent('info', localize('microide.effortChanged', "microClaude effort changed"), appliedEffort, sessionId);
		this.emitState();
	}

	async addCustomModel(model: IMicroIDECustomModel): Promise<void> {
		this.assertAuthenticated();
		const id = model.id.trim();
		const label = (model.label || id).trim();
		if (!id) {
			throw new Error(localize('microide.customModelIdRequired', "Custom model id is required"));
		}

		const entry: IMicroIDECustomModel = {
			id,
			label: label || id,
			baseUrl: model.baseUrl?.trim() || undefined,
			apiKey: model.apiKey?.trim() || undefined
		};
		const existingIndex = this.customModels.findIndex(candidate => candidate.id === id);
		if (existingIndex >= 0) {
			this.customModels.splice(existingIndex, 1, entry);
		} else {
			this.customModels.push(entry);
		}
		this.persistCustomModels();
		this.pushEvent('info', localize('microide.customModelAdded', "Custom model added"), entry.label, null);
		await this.setSelectedModel(id);
	}

	async removeCustomModel(modelId: string): Promise<void> {
		this.assertAuthenticated();
		const index = this.customModels.findIndex(candidate => candidate.id === modelId);
		if (index === -1) {
			return;
		}
		this.customModels.splice(index, 1);
		this.persistCustomModels();
		// Fall back to a built-in model if the removed one was selected.
		if (this.selectedModel === modelId) {
			const fallback = this.configuration?.defaultModel ?? this.configuration?.models[0]?.id;
			if (fallback) {
				await this.setSelectedModel(fallback);
			} else {
				this.selectedModel = null;
				this.emitState();
			}
		} else {
			this.emitState();
		}
	}

	async setAgentMode(mode: MicroIDEAgentMode): Promise<void> {
		this.assertAuthenticated();
		if (mode === this.agentMode) {
			return;
		}

		if (this.status === 'busy') {
			throw new Error('Cannot change microClaude agent mode while a turn is running');
		}

		this.agentMode = mode;
		this.teamState = mode === 'multiAgent' ? this.teamState : DEFAULT_TEAM_STATE;
		this.updateActiveSessionMode(mode);
		this.pushEvent('info', localize('microide.agentModeChanged', "microClaude agent mode changed"), agentModeEventLabel(mode), this.session?.id ?? null);
		this.emitState();
	}

	private getMergedConfiguration(): IMicroClaudeConfiguration | null {
		if (!this.configuration) {
			if (!this.customModels.length) {
				return null;
			}
			// No engine configuration yet, but surface custom models so they remain selectable.
			return {
				defaultModel: this.customModels[0].id,
				selectedModel: this.selectedModel ?? this.customModels[0].id,
				models: this.customModels.map(toModelConfiguration)
			};
		}

		if (!this.customModels.length) {
			return this.configuration;
		}

		const builtinIds = new Set(this.configuration.models.map(model => model.id));
		const extras = this.customModels.filter(model => !builtinIds.has(model.id)).map(toModelConfiguration);
		return { ...this.configuration, models: [...this.configuration.models, ...extras] };
	}

	private endpointForModel(modelId: string | null | undefined): { baseUrl?: string; apiKey?: string } {
		const custom = modelId ? this.customModels.find(model => model.id === modelId) : undefined;
		if (!custom) {
			return {};
		}
		return {
			...(custom.baseUrl ? { baseUrl: custom.baseUrl } : {}),
			...(custom.apiKey ? { apiKey: custom.apiKey } : {})
		};
	}

	private modelEndpointChanged(previousModel: string | null, nextModel: string): boolean {
		const previous = this.endpointForModel(previousModel);
		const next = this.endpointForModel(nextModel);
		return previous.baseUrl !== next.baseUrl || previous.apiKey !== next.apiKey;
	}

	private updateActiveSessionModel(model: string): void {
		if (!this.session) {
			return;
		}

		const session: IMicroClaudeSession = {
			...this.session,
			model,
			updatedAt: new Date().toISOString()
		};
		this.session = session;
		this.sessionStore.set(session.id, session);
		this.updateSessionTab(session.id, {
			model,
			status: session.status,
			updatedAt: Date.now()
		});
	}

	private updateActiveSessionMode(mode: MicroIDEAgentMode): void {
		if (!this.session) {
			return;
		}

		const session: IMicroClaudeSession = {
			...this.session,
			mode,
			updatedAt: new Date().toISOString()
		};
		this.session = session;
		this.sessionStore.set(session.id, session);
		this.updateSessionTab(session.id, {
			updatedAt: Date.now()
		});
	}

	private restoreCustomModels(): void {
		try {
			const raw = this.storageService.get(CUSTOM_MODELS_STORAGE_KEY, StorageScope.APPLICATION);
			if (!raw) {
				return;
			}
			const parsed = JSON.parse(raw) as IMicroIDECustomModel[];
			if (!Array.isArray(parsed)) {
				return;
			}
			for (const model of parsed) {
				if (model && typeof model.id === 'string' && model.id) {
					this.customModels.push({ id: model.id, label: model.label || model.id, baseUrl: model.baseUrl, apiKey: model.apiKey });
				}
			}
		} catch (error) {
			this.logService.warn(`[microide] failed to restore custom models: ${toErrorMessage(error)}`);
		}
	}

	private persistCustomModels(): void {
		try {
			// Custom endpoints (including tokens) are user-scoped machine secrets.
			this.storageService.store(CUSTOM_MODELS_STORAGE_KEY, JSON.stringify(this.customModels), StorageScope.APPLICATION, StorageTarget.MACHINE);
		} catch (error) {
			this.logService.warn(`[microide] failed to persist custom models: ${toErrorMessage(error)}`);
		}
	}

	async setPermissionMode(mode: MicroIDEPermissionMode): Promise<void> {
		this.assertAuthenticated();
		if (mode === this.permissionMode) {
			return;
		}

		if (this.status === 'busy') {
			throw new Error('Cannot change microClaude permission mode while a turn is running');
		}

		this.permissionMode = mode;
		this.emitState();

		if (!this.session) {
			return;
		}

		const previousSessionId = this.session.id;
		const workspace = this.session.workspace ?? this.getWorkspacePath();
		try {
			await this.microClaudeSidecarService.disposeSession(previousSessionId);
		} catch (error) {
			this.pushEvent('warning', localize('microide.permissionModeDisposeWarning', "Previous microClaude session could not be disposed"), toErrorMessage(error), previousSessionId);
		}

		const started = await this.startAgentSession({
			workspace: workspace ?? undefined,
			model: this.selectedModel ?? undefined
		});
		this.liveSessions.delete(previousSessionId);
		this.session = started.session;
		this.liveSessions.add(started.session.id);
		this.migrateSession(previousSessionId, started.session);
		this.error = null;
		this.setStatus(started.session.status === 'busy' ? 'busy' : 'ready');
		this.pushEvent('info', localize('microide.permissionModeChanged', "microClaude permission mode changed"), permissionModeEventLabel(mode), started.session.id);
	}

	async startNewSession(): Promise<void> {
		this.assertAuthenticated();
		await this.ensureReady();
		if (this.status === 'busy') {
			throw new Error('Cannot start a new microClaude session while a turn is running');
		}

		// If the current session has no messages yet, it is already an empty "new session" �?		// reuse it rather than stacking another blank tab.
		const started = await this.startAgentSession({
			workspace: this.getWorkspacePath(),
			model: this.selectedModel ?? undefined
		});

		this.session = started.session;
		this.teamState = DEFAULT_TEAM_STATE;
		this.activeAssistantMessageIds.delete(started.session.id);
		this.error = null;
		this.liveSessions.add(started.session.id);
		this.rememberSession(started.session);
		this.setStatus(started.session.status === 'busy' ? 'busy' : 'ready');
		this.pushEvent('info', localize('microide.newSessionStarted', "New microClaude session started"), undefined, started.session.id);
	}

	async renameSession(sessionId: string, title: string): Promise<void> {
		const tab = this.sessionTabs.find(candidate => candidate.id === sessionId);
		if (!tab) {
			throw new Error(localize('microide.sessionNotFound', "microClaude session was not found"));
		}

		const normalized = normalizeSessionTitle(title);
		this.updateSessionTab(sessionId, {
			title: normalized,
			customTitle: normalized,
			updatedAt: Date.now()
		});
		this.pushEvent('info', localize('microide.sessionRenamed', "Session renamed"), normalized, sessionId);
		this.emitState();
	}

	async switchSession(sessionId: string): Promise<void> {
		this.assertAuthenticated();

		const session = this.sessionStore.get(sessionId);
		if (!session) {
			throw new Error(localize('microide.sessionNotFound', "microClaude session was not found"));
		}

		// A session restored from storage after a restart is not yet live in the
		// engine process. Resume it so microClaude replays its persisted transcript
		// before the user continues the conversation.
		if (!this.liveSessions.has(sessionId)) {
			await this.ensureReady();
			try {
				const resumed = await this.microClaudeSidecarService.resumeSession({
					sessionId,
					workspace: session.workspace ?? this.getWorkspacePath(),
					model: session.model ?? this.selectedModel ?? undefined,
					mode: normalizeAgentMode(session.mode) ?? 'agent',
					...this.endpointForModel(session.model ?? this.selectedModel),
					...this.getPermissionSessionOptions()
				});
				this.liveSessions.add(resumed.session.id);
				this.sessionStore.set(resumed.session.id, resumed.session);
				this.session = resumed.session;
				this.agentMode = normalizeAgentMode(resumed.session.mode) ?? this.agentMode;
				this.teamState = DEFAULT_TEAM_STATE;
				this.error = null;
				this.updateSessionTab(resumed.session.id, {
					closed: false,
					updatedAt: Date.now()
				});
				this.setStatus(resumed.session.status === 'busy' ? 'busy' : 'ready');
				this.pushEvent('info', localize('microide.sessionResumed', "microClaude session resumed"), undefined, resumed.session.id);
				return;
			} catch (error) {
				this.pushEvent('warning', localize('microide.sessionResumeWarning', "microClaude session could not be resumed"), toErrorMessage(error), sessionId);
			}
		}

		this.session = session;
		this.agentMode = normalizeAgentMode(session.mode) ?? this.agentMode;
		this.teamState = DEFAULT_TEAM_STATE;
		this.error = null;
		this.updateSessionTab(sessionId, {
			closed: false,
			updatedAt: Date.now()
		});
		this.setStatus(session.status === 'busy' ? 'busy' : 'ready');
	}

	async closeSession(sessionId: string): Promise<void> {
		this.assertAuthenticated();
		if (this.status === 'busy' && this.session?.id === sessionId) {
			throw new Error(localize('microide.closeBusySession', "Cannot close a running microClaude session"));
		}

		const wasActive = this.session?.id === sessionId;
		const nextTab = wasActive ? this.pickNextOpenSessionTab(sessionId) : undefined;
		const hasContent = this.sessionHasContent(sessionId);
		try {
			if (this.liveSessions.has(sessionId)) {
				await this.microClaudeSidecarService.disposeSession(sessionId);
			}
		} catch (error) {
			this.pushEvent('warning', localize('microide.closeSessionDisposeWarning', "microClaude session could not be disposed"), toErrorMessage(error), sessionId);
		}

		this.liveSessions.delete(sessionId);
		this.activeAssistantMessageIds.delete(sessionId);
		if (hasContent) {
			this.updateSessionTab(sessionId, {
				closed: true,
				updatedAt: Date.now()
			});
		} else {
			this.removeSession(sessionId);
		}

		if (wasActive) {
			this.session = null;
			if (nextTab) {
				await this.switchSession(nextTab.id);
			} else {
				this.setStatus('ready');
			}
		} else {
			this.emitState();
		}
	}

	async installPlugin(pluginId: string): Promise<void> {
		this.assertAuthenticated();
		const plugin = pluginId.trim();
		if (!plugin) {
			return;
		}
		await this.ensureReady();
		const result = await this.microClaudeSidecarService.installPlugin({
			plugin,
			workspace: this.getWorkspacePath(),
			scope: 'user'
		});
		this.plugins = {
			installed: Array.isArray(result.installed) ? result.installed.slice() : [],
			available: Array.isArray(result.available) ? result.available.slice() : [],
			refreshedAt: result.refreshedAt ?? new Date().toISOString()
		};
		await this.refreshSkills();
		this.emitState();
	}

	async uninstallPlugin(pluginId: string): Promise<void> {
		this.assertAuthenticated();
		const plugin = pluginId.trim();
		if (!plugin) {
			return;
		}
		await this.ensureReady();
		const result = await this.microClaudeSidecarService.uninstallPlugin({
			plugin,
			workspace: this.getWorkspacePath()
		});
		this.plugins = {
			installed: Array.isArray(result.installed) ? result.installed.slice() : [],
			available: Array.isArray(result.available) ? result.available.slice() : [],
			refreshedAt: result.refreshedAt ?? new Date().toISOString()
		};
		await this.refreshSkills();
		this.emitState();
	}
	async sendPrompt(prompt: string, attachments?: readonly IMicroIDEImageAttachment[], context?: readonly IMicroIDEFileContextAttachment[]): Promise<void> {
		this.assertAuthenticated();
		const trimmed = prompt.trim();
		const images = attachments ?? [];
		const fileContext = (context ?? []).filter(item => item.enabled && item.path.trim());
		if (!trimmed && !images.length) {
			return;
		}

		await this.ensureReady();
		await this.ensureAgentSession();

		const sessionId = this.session?.id;
		if (!sessionId) {
			throw new Error('microClaude session is not ready');
		}

		this.pushMessage('user', trimmed, 'complete', sessionId, {
			...(images.length ? { attachments: images } : {}),
			...(fileContext.length ? { fileContexts: fileContext } : {})
		});
		this.activeAssistantMessageIds.delete(sessionId);
		this.beginTurn(sessionId);
		this.setStatus('busy');

		try {
			const promptForEngine = this.buildPromptForEngine(trimmed, fileContext);
			const content = images.length ? this.buildContentBlocks(promptForEngine, images) : undefined;
			await this.microClaudeSidecarService.sendMessage({
				sessionId,
				prompt: promptForEngine,
				model: this.selectedModel ?? undefined,
				mode: this.agentMode,
				...(content ? { content } : {})
			});
		} catch (error) {
			this.markActiveAssistantError(sessionId, toErrorMessage(error));
			this.error = toErrorMessage(error);
			this.setStatus('error');
			throw error;
		}
	}

	async improvePrompt(prompt: string, mode: 'working' | 'coding', context?: readonly IMicroIDEFileContextAttachment[]): Promise<string> {
		this.assertAuthenticated();
		await this.ensureReady();

		const fileContext = (context ?? []).filter(item => item.enabled && item.path.trim());
		const result = await this.microClaudeSidecarService.improvePrompt({
			prompt,
			mode,
			workspace: this.getWorkspacePath(),
			model: this.selectedModel ?? undefined,
			...this.endpointForModel(this.selectedModel),
			...(fileContext.length ? { context: fileContext.map(item => this.toImprovePromptContext(item)) } : {})
		});
		const improved = result.prompt.trim();
		if (!improved) {
			throw new Error(localize('microide.improvePromptEmpty', "microClaude did not return an improved prompt."));
		}
		return improved;
	}

	private toImprovePromptContext(item: IMicroIDEFileContextAttachment): IMicroClaudeImprovePromptContextItem {
		return {
			path: item.path,
			label: item.label,
			source: item.source,
			...(item.selectionLineCount ? { selectionLineCount: item.selectionLineCount } : {}),
			...(item.selectedTextLength ? { selectedTextLength: item.selectedTextLength } : {}),
			...(item.selectionRanges?.length ? { selectionRanges: item.selectionRanges } : {})
		};
	}

	private buildPromptForEngine(prompt: string, context: readonly IMicroIDEFileContextAttachment[]): string {
		if (!context.length) {
			return prompt;
		}

		const lines = [
			'<microide_context_files>',
			...context.map(item => `- ${item.path} (${this.describeFileContext(item)})`),
			'</microide_context_files>',
			'Use these workspace files as explicit context for this turn. If selected ranges are present, treat them as the intended focus. Read the file with tools if exact contents are needed; do not assume large file contents are already in the prompt.',
			''
		];

		lines.push(prompt);
		return lines.join('\n');
	}

	private describeFileContext(item: IMicroIDEFileContextAttachment): string {
		const parts = [item.source === 'activeEditor' ? 'current open file' : 'mentioned file'];
		if (item.selectionLineCount && item.selectionRanges?.length) {
			const ranges = item.selectionRanges
				.map(range => range.startLineNumber === range.endLineNumber ? String(range.startLineNumber) : `${range.startLineNumber}-${range.endLineNumber}`)
				.join(', ');
			parts.push(`selected ${item.selectionLineCount} lines: ${ranges}`);
		}
		return parts.join(', ');
	}

	private buildContentBlocks(text: string, attachments: readonly IMicroIDEImageAttachment[]): IMicroClaudeContentBlock[] {
		const blocks: IMicroClaudeContentBlock[] = [];
		if (text) {
			blocks.push({ type: 'text', text });
		}
		for (const attachment of attachments) {
			blocks.push({
				type: 'image',
				source: { type: 'base64', media_type: attachment.mediaType, data: attachment.data }
			});
		}
		return blocks;
	}

	private async ensureAgentSession(): Promise<void> {
		await this.ensureReady();

		if (this.session && this.status !== 'error') {
			return;
		}

		const workspace = this.getWorkspacePath();
		const started = await this.startAgentSession({
			workspace,
			model: this.selectedModel ?? undefined
		});

		this.session = started.session;
		// Track the session but defer creating a visible tab until it has actual content
		// (see pushMessage) so a freshly-opened panel shows a single empty-state tab, not a
		// stray "鏂颁細璇? for every bare session spin-up.
		this.sessionStore.set(started.session.id, started.session);
		this.error = null;
		this.liveSessions.add(started.session.id);
		this.setStatus(started.session.status === 'busy' ? 'busy' : 'ready');
	}

	private getPermissionSessionOptions(): { autoApprove: boolean; permissionMode?: string } {
		switch (this.permissionMode) {
			case 'ask':
				return { autoApprove: false };
			case 'fullAccess':
				return { autoApprove: true, permissionMode: 'bypassPermissions' };
			default:
				return { autoApprove: true, permissionMode: 'acceptEdits' };
		}
	}

	private startAgentSession(options: { workspace?: string; model?: string | null } = {}) {
		const model = options.model ?? this.selectedModel ?? undefined;
		return this.microClaudeSidecarService.startSession({
			workspace: options.workspace ?? this.getWorkspacePath(),
			model: model ?? undefined,
			mode: this.agentMode,
			...this.endpointForModel(model),
			...this.getPermissionSessionOptions()
		});
	}

	async cancelActiveSession(): Promise<void> {
		const sessionId = this.session?.id;
		if (!sessionId) {
			return;
		}

		try {
			await this.microClaudeSidecarService.cancelSession(sessionId);
			this.markActiveAssistantInterrupted(sessionId);
			this.finishTurn(sessionId, 'interrupted');
			this.pushEvent('warning', localize('microide.sessionCancelled', "microClaude turn cancelled"), undefined, sessionId);
			this.setStatus('ready');
		} catch (error) {
			this.error = toErrorMessage(error);
			this.setStatus('error');
			throw error;
		}
	}

	async approvePermission(requestId: string, reason?: string, updatedInput?: unknown, updatedPermissions?: readonly unknown[]): Promise<void> {
		this.assertAuthenticated();
		await this.ensureReady();
		await this.resolvePermission(requestId, true, reason, updatedInput, updatedPermissions);
	}

	async approveAllEditsForSession(requestId: string): Promise<void> {
		this.assertAuthenticated();
		await this.ensureReady();
		const request = this.permissions.find(candidate => candidate.requestId === requestId);
		if (request?.sessionId) {
			this.sessionEditAllowAll.add(request.sessionId);
			this.pushEvent('info', localize('microide.allowEditsForSession', "Allowing all edits for this session"), request.path ?? request.summary, request.sessionId);
		}
		await this.resolvePermission(requestId, true);
	}

	async approvePermissionForProject(requestId: string): Promise<void> {
		await this.approveAllEditsForSession(requestId);
	}

	async denyPermission(requestId: string, reason?: string): Promise<void> {
		this.assertAuthenticated();
		await this.ensureReady();
		await this.resolvePermission(requestId, false, reason);
	}

	private restoreAllowRules(): void {
		try {
			const raw = this.storageService.get(ALLOW_RULES_STORAGE_KEY, StorageScope.WORKSPACE);
			if (!raw) {
				return;
			}
			const parsed = JSON.parse(raw) as string[];
			if (Array.isArray(parsed)) {
				for (const rule of parsed) {
					if (typeof rule === 'string' && rule) {
						this.allowRules.add(rule);
					}
				}
			}
		} catch (error) {
			this.logService.warn(`[microide] failed to restore allow rules: ${toErrorMessage(error)}`);
		}
	}

	clearMessages(): void {
		const activeSessionId = this.session?.id ?? null;
		removeSessionItems(this.messages, activeSessionId);
		removeSessionItems(this.events, activeSessionId);
		this.todos.splice(0, this.todos.length);
		if (activeSessionId) {
			this.activeAssistantMessageIds.delete(activeSessionId);
		} else {
			this.activeAssistantMessageIds.clear();
		}
		this.emitState();
	}

	clearResolvedPermissions(): void {
		for (let index = this.permissions.length - 1; index >= 0; index--) {
			if (this.permissions[index].state !== 'pending') {
				this.permissions.splice(index, 1);
			}
		}
		this.emitState();
	}

	private async resolvePermission(requestId: string, approve: boolean, reason?: string, updatedInput?: unknown, updatedPermissions?: readonly unknown[]): Promise<void> {
		const existing = this.permissions.find(request => request.requestId === requestId);
		if (!existing || existing.state !== 'pending') {
			return;
		}

		try {
			const result = await this.microClaudeSidecarService.resolvePermission({
				requestId,
				approve,
				...(reason ? { reason } : {}),
				...(updatedInput !== undefined ? { updatedInput } : {}),
				...(updatedPermissions !== undefined ? { updatedPermissions } : {})
			});
			this.updatePermission(requestId, result.resolved ? (approve ? 'approved' : 'denied') : 'error', result.reason ?? reason);
		} catch (error) {
			const message = toErrorMessage(error);
			this.updatePermission(requestId, 'error', message);
			this.pushEvent('error', localize('microide.permissionResolveFailed', "Permission resolution failed"), message, existing.sessionId);
			throw error;
		}
	}

	private acceptSidecarEvent(event: IMicroClaudeSidecarEvent): void {
		switch (event.event) {
			case 'assistant.delta':
				this.appendAssistantDelta(event);
				break;
			case 'assistant.message':
				this.acceptAssistantMessage(event);
				break;
			case 'todo.update':
				this.acceptTodos(event.payload);
				break;
			case 'tool.request':
				this.acceptToolRequest(event);
				break;
			case 'tool.result':
				this.acceptToolResult(event);
				break;
			case 'team.created':
				this.acceptTeamCreated(event);
				break;
			case 'team.teammate.started':
				this.acceptTeamTeammateStarted(event);
				break;
			case 'team.message.sent':
			case 'team.message.received':
				this.acceptTeamMessage(event);
				break;
			case 'team.deleted':
				this.acceptTeamDeleted(event);
				break;
			case 'team.task.updated':
				this.acceptTeamTaskUpdated(event);
				break;
			case 'task.started':
			case 'task.progress':
			case 'task.updated':
			case 'task.notification':
				this.acceptRuntimeTaskEvent(event);
				break;
			case 'permission.request':
				this.acceptPermissionRequest(event);
				break;
			case 'permission.cancel':
				this.acceptPermissionCancel(event);
				break;
			case 'engine.started':
				this.pushEvent('info', localize('microide.engineStarted', "Engine process started"), formatCompactJson(event.payload), event.sessionId);
				break;
			case 'engine.stderr':
				this.pushEvent('warning', localize('microide.engineStderr', "Engine stderr"), getStringField(asRecord(event.payload), 'line') ?? formatCompactJson(event.payload), event.sessionId);
				break;
			case 'engine.stdout':
				this.pushEvent('info', localize('microide.engineStdout', "Engine stdout"), getStringField(asRecord(event.payload), 'line') ?? formatCompactJson(event.payload), event.sessionId);
				break;
			case 'session.status':
				this.acceptSessionStatus(event);
				break;
			case 'session.title':
				this.acceptSessionTitle(event);
				break;
			case 'session.result':
				this.completeActiveAssistantMessage(event.sessionId);
				this.finishTurn(event.sessionId, 'done');
				this.pushEvent('info', localize('microide.sessionResult', "microClaude turn completed"), formatCompactJson(event.payload), event.sessionId);
				break;
			case 'session.error':
				const sessionError = getStringField(asRecord(event.payload), 'message') ?? formatCompactJson(event.payload) ?? null;
				if (event.sessionId) {
					this.markActiveAssistantError(event.sessionId, sessionError ?? localize('microide.sessionError', "microClaude turn failed"));
				}
				this.finishTurn(event.sessionId, 'error');
				this.pushEvent('error', localize('microide.sessionError', "microClaude turn failed"), sessionError ?? undefined, event.sessionId);
				if (this.session?.id === event.sessionId) {
					this.error = sessionError;
					this.setStatus('error');
				} else {
					this.emitState();
				}
				break;
		}
	}

	private appendAssistantDelta(event: IMicroClaudeSidecarEvent): void {
		const text = getStringField(asRecord(event.payload), 'text');
		if (!text) {
			return;
		}

		this.updateTurnStatus(event.sessionId, 'thinking');

		const sessionId = event.sessionId;
		const activeAssistantMessageId = sessionId ? this.activeAssistantMessageIds.get(sessionId) : undefined;
		let message = this.messages.find(candidate => candidate.id === activeAssistantMessageId);
		if (!message) {
			message = this.pushMessage('assistant', '', 'streaming', event.sessionId);
			if (sessionId) {
				this.activeAssistantMessageIds.set(sessionId, message.id);
			}
		}

		this.replaceMessage(message.id, {
			...message,
			text: message.text + text,
			state: 'streaming'
		});
	}

	private acceptAssistantMessage(event: IMicroClaudeSidecarEvent): void {
		const text = getStringField(asRecord(event.payload), 'text') ?? '';
		const sessionId = event.sessionId;
		const activeAssistantMessageId = sessionId ? this.activeAssistantMessageIds.get(sessionId) : undefined;
		const active = this.messages.find(candidate => candidate.id === activeAssistantMessageId);
		if (active) {
			this.replaceMessage(active.id, {
				...active,
				text: text || active.text,
				state: 'complete'
			});
			if (sessionId) {
				this.activeAssistantMessageIds.delete(sessionId);
			}
			return;
		}

		if (text) {
			this.pushMessage('assistant', text, 'complete', event.sessionId);
		}
	}

	private acceptTodos(payload: unknown): void {
		const record = asRecord(payload);
		const items = Array.isArray(record?.items) ? record.items : [];
		this.todos.splice(0, this.todos.length, ...items.map((item, index) => {
			const itemRecord = asRecord(item);
			return {
				id: getStringField(itemRecord, 'id') ?? `todo-${index}`,
				text: getStringField(itemRecord, 'text') ?? getStringField(itemRecord, 'title') ?? localize('microide.todoUntitled', "Untitled step"),
				status: getStringField(itemRecord, 'status') ?? 'pending'
			};
		}));
		this.emitState();
	}

	private acceptToolRequest(event: IMicroClaudeSidecarEvent): void {
		const payload = asRecord(event.payload);
		const toolName = getStringField(payload, 'name') ?? localize('microide.unknownTool', "Tool");
		const input = payload?.input;
		const toolUseId = getStringField(payload, 'toolUseId') ?? getStringField(payload, 'tool_use_id') ?? this.nextId('tool');
		const summary = summarizeToolUse(toolName, input);
		const existing = this.findToolMessage(toolUseId);
		const diff = buildDiffPreview(toolName, input, existing?.output);
		const nextDiff = diff ?? existing?.diff;
		const toolEffect = classifyToolEffect(toolName, input, undefined, Boolean(nextDiff));
		this.completeActiveAssistantMessage(event.sessionId);
		this.updateTurnStatus(event.sessionId, 'runningTool', toolName, summary.summary);
		const update = {
			toolUseId,
			toolName,
			toolEffect,
			summary: summary.summary,
			input,
			...(summary.path ? { path: summary.path } : {}),
			...(summary.command ? { command: summary.command } : {}),
			...(nextDiff ? { diff: nextDiff } : {})
		};

		if (existing) {
			this.replaceMessage(existing.id, {
				...existing,
				...update,
				text: summary.summary,
				state: existing.state === 'complete' || existing.state === 'error' ? existing.state : 'streaming'
			});
		} else {
			this.pushMessage('tool', summary.summary, 'streaming', event.sessionId, update);
		}

		this.pushEvent('info', localize('microide.toolRequested', "Tool requested: {0}", toolName), formatCompactJson(input), event.sessionId);
	}

	private acceptToolResult(event: IMicroClaudeSidecarEvent): void {
		const payload = asRecord(event.payload);
		const incomingToolUseId = getStringField(payload, 'toolUseId') ?? getStringField(payload, 'tool_use_id');
		const existing = incomingToolUseId ? this.findToolMessage(incomingToolUseId) : undefined;
		const toolUseId = incomingToolUseId ?? existing?.toolUseId ?? this.nextId('tool');
		const toolName = getStringField(payload, 'name') ?? existing?.toolName ?? localize('microide.unknownTool', "Tool");
		const input = payload?.input ?? existing?.input;
		const output = payload?.output ?? payload?.content;
		const isError = Boolean(payload?.isError ?? payload?.is_error);
		const summary = summarizeToolUse(toolName, input, output);
		const diff = buildDiffPreview(toolName, input, output) ?? existing?.diff;
		const toolEffect = classifyToolEffect(toolName, input, output, Boolean(diff));
		const state: MicroIDEAgentMessageState = isError ? 'error' : 'complete';
		if (!existing) {
			this.completeActiveAssistantMessage(event.sessionId);
		}
		this.updateTurnStatus(event.sessionId, 'runningTool', toolName, summary.summary);
		const messageUpdate = {
			toolUseId,
			toolName,
			toolEffect,
			summary: summary.summary,
			input,
			output,
			isError,
			...teamToolMessageAttribution(toolName, input, output, this.teamState.teamName),
			...(summary.path ? { path: summary.path } : {}),
			...(summary.command ? { command: summary.command } : {}),
			...(diff ? { diff } : {})
		};

		if (existing) {
			this.replaceMessage(existing.id, {
				...existing,
				...messageUpdate,
				text: summary.summary,
				state
			});
		} else {
			this.pushMessage('tool', summary.summary, state, event.sessionId, messageUpdate);
		}

		this.pushEvent(isError ? 'warning' : 'info', localize('microide.toolCompleted', "Tool completed: {0}", toolName), outputTextForEvent(output), event.sessionId);
		this.updateTurnStatus(event.sessionId, 'thinking', '', '');
	}

	private acceptTeamCreated(event: IMicroClaudeSidecarEvent): void {
		const payload = asRecord(event.payload);
		const teamName = getStringField(payload, 'teamName');
		if (!teamName) {
			return;
		}

		const leadAgentId = getStringField(payload, 'leadAgentId');
		const now = Date.now();
		const members = leadAgentId
			? upsertTeamMember(this.teamState.members, {
				id: leadAgentId,
				name: 'team-lead',
				agentType: 'team-lead',
				status: 'running',
				startedAt: now,
				lastActivityAt: now
			})
			: this.teamState.members;

		this.teamState = {
			...this.teamState,
			teamName,
			teamFilePath: getStringField(payload, 'teamFilePath'),
			leadAgentId,
			status: 'active',
			members
		};
		this.pushEvent('info', localize('microide.teamCreated', "Agent team created"), teamName, event.sessionId);
		this.emitState();
	}

	private acceptTeamTeammateStarted(event: IMicroClaudeSidecarEvent): void {
		const payload = asRecord(event.payload);
		const id = getStringField(payload, 'agentId') ?? getStringField(payload, 'teammateId');
		const name = getStringField(payload, 'name');
		if (!id || !name) {
			return;
		}

		const now = Date.now();
		this.teamState = {
			...this.teamState,
			teamName: getStringField(payload, 'teamName') ?? this.teamState.teamName,
			status: 'active',
			members: upsertTeamMember(this.teamState.members, {
				id,
				name,
				agentType: getStringField(payload, 'agentType'),
				model: getStringField(payload, 'model'),
				color: getStringField(payload, 'color'),
				backend: getStringField(payload, 'backend'),
				status: 'running',
				startedAt: now,
				lastActivityAt: now
			})
		};
		this.pushEvent('info', localize('microide.teammateStarted', "Teammate started"), name, event.sessionId);
		this.emitState();
	}

	private acceptTeamMessage(event: IMicroClaudeSidecarEvent): void {
		const payload = asRecord(event.payload);
		const messageText = stringifyTeamMessage(payload?.message) ?? getStringField(payload, 'text');
		const message: IMicroIDEAgentTeamMessage = {
			id: this.nextId('team-message'),
			from: getStringField(payload, 'from'),
			to: getStringField(payload, 'to'),
			summary: getStringField(payload, 'summary'),
			text: messageText,
			createdAt: Date.now()
		};
		this.teamState = {
			...this.teamState,
			messages: [...this.teamState.messages, message].slice(-80)
		};
		this.emitState();
	}

	private acceptTeamDeleted(event: IMicroClaudeSidecarEvent): void {
		const payload = asRecord(event.payload);
		const success = payload?.success !== false;
		this.teamState = success
			? DEFAULT_TEAM_STATE
			: { ...this.teamState, status: 'error' };
		this.pushEvent(
			success ? 'info' : 'warning',
			success ? localize('microide.teamDeleted', "Agent team deleted") : localize('microide.teamDeleteFailed', "Agent team cleanup failed"),
			getStringField(payload, 'message') ?? getStringField(payload, 'teamName'),
			event.sessionId
		);
		this.emitState();
	}

	private acceptTeamTaskUpdated(event: IMicroClaudeSidecarEvent): void {
		const payload = asRecord(event.payload);
		const output = extractNestedRecord(payload?.output);
		const input = asRecord(payload?.input);
		const toolName = getStringField(payload, 'toolName');
		if (toolName === 'TaskList' && Array.isArray(output?.tasks)) {
			this.teamState = {
				...this.teamState,
				tasks: output.tasks
					.map(normalizeTeamTaskRecord)
					.filter((task): task is IMicroIDEAgentTeamTask => Boolean(task))
			};
			this.emitState();
			return;
		}
		const task = normalizeTeamTaskFromTool(toolName, input, output);
		if (!task) {
			return;
		}
		this.teamState = {
			...this.teamState,
			tasks: upsertTeamTask(this.teamState.tasks, task)
		};
		this.emitState();
	}

	private acceptRuntimeTaskEvent(event: IMicroClaudeSidecarEvent): void {
		const payload = asRecord(event.payload);
		const taskId = getStringField(payload, 'taskId');
		if (!taskId) {
			return;
		}

		const task: IMicroIDEAgentTeamTask = {
			id: taskId,
			subject: getStringField(payload, 'description') ?? getStringField(payload, 'summary') ?? taskId,
			status: runtimeTaskStatus(event.event, getStringField(payload, 'status')),
			owner: getStringField(payload, 'taskType'),
			blockedBy: []
		};
		this.teamState = {
			...this.teamState,
			tasks: upsertTeamTask(this.teamState.tasks, task)
		};
		this.emitState();
	}

	private acceptPermissionRequest(event: IMicroClaudeSidecarEvent): void {
		const request = normalizePermissionRequest(event);
		this.completeActiveAssistantMessage(event.sessionId);
		this.updateTurnStatus(event.sessionId, 'waitingPermission', request.toolName, request.summary);
		const existingIndex = this.permissions.findIndex(candidate => candidate.requestId === request.requestId);
		if (existingIndex >= 0) {
			this.permissions[existingIndex] = request;
		} else {
			pushLimited(this.permissions, request, MAX_PERMISSIONS);
		}

		const effect = classifyToolEffect(request.toolName, request.input, request.raw, Boolean(request.diff));
		if (request.sessionId && effect === 'edit' && this.sessionEditAllowAll.has(request.sessionId)) {
			this.pushEvent('info', localize('microide.permissionAutoApprovedSessionEdits', "Auto-approved edit for this session"), request.summary, event.sessionId);
			this.emitState();
			void this.resolvePermission(request.requestId, true).catch(error => this.logService.warn(`[microide] session edit auto-approve failed: ${toErrorMessage(error)}`));
			return;
		}

		// Auto-approve when the user previously chose an exact persistent allow rule.
		const rule = allowRuleKey(request.toolName, request.command, request.path);
		if (rule && this.allowRules.has(rule)) {
			this.pushEvent('info', localize('microide.permissionAutoApproved', "Auto-approved {0} (allowed for project)", request.toolName), request.summary, event.sessionId);
			this.emitState();
			void this.resolvePermission(request.requestId, true).catch(error => this.logService.warn(`[microide] auto-approve failed: ${toErrorMessage(error)}`));
			return;
		}

		this.pushEvent('warning', localize('microide.permissionRequested', "Permission requested: {0}", request.toolName), request.summary, event.sessionId);
		this.emitState();
	}

	private acceptPermissionCancel(event: IMicroClaudeSidecarEvent): void {
		const requestId = getStringField(asRecord(event.payload), 'requestId');
		if (requestId) {
			this.updatePermission(requestId, 'cancelled');
		}
	}

	private acceptSessionStatus(event: IMicroClaudeSidecarEvent): void {
		const payload = asRecord(event.payload);
		const status = getStringField(payload, 'status');
		const session = asSession(payload?.session);
		if (session) {
			if (this.session?.id === session.id) {
				this.session = session;
			}
			this.sessionStore.set(session.id, session);
			if (this.sessionTabs.some(tab => tab.id === session.id)) {
				this.rememberSession(session);
			}
		}

		if (status === 'busy') {
			this.touchSession(event.sessionId, undefined, 'busy');
			if (this.session?.id === event.sessionId) {
				this.setStatus('busy');
			} else {
				this.emitState();
			}
		} else if (status === 'ready' || status === 'initialized') {
			this.touchSession(event.sessionId, undefined, 'ready');
			this.catalogRefreshScheduler.schedule();
			if (this.session?.id === event.sessionId) {
				this.setStatus('ready');
			} else {
				this.emitState();
			}
		} else if (status) {
			this.touchSession(event.sessionId, undefined, status);
			this.pushEvent('info', localize('microide.sessionStatusChanged', "Session status changed"), status, event.sessionId);
			this.emitState();
		}
	}

	private acceptSessionTitle(event: IMicroClaudeSidecarEvent): void {
		const sessionId = event.sessionId;
		if (!sessionId) {
			return;
		}

		const payload = asRecord(event.payload);
		const title = getStringField(payload, 'title') ?? getStringField(payload, 'customTitle') ?? getStringField(payload, 'aiTitle');
		if (!title) {
			return;
		}

		const tab = this.sessionTabs.find(candidate => candidate.id === sessionId);
		if (!tab) {
			return;
		}
		const normalized = normalizeSessionTitle(title);
		this.updateSessionTab(sessionId, {
			title: tab.customTitle ?? normalized,
			generatedTitle: normalized,
			updatedAt: Date.now()
		});
		this.emitState();
	}

	private rememberSession(session: IMicroClaudeSession, title?: string): void {
		this.sessionStore.set(session.id, session);
		const existing = this.sessionTabs.find(tab => tab.id === session.id);
		const now = Date.now();
		if (existing) {
			const normalizedTitle = title ? normalizeSessionTitle(title) : undefined;
			this.updateSessionTab(session.id, {
				title: existing.customTitle ?? normalizedTitle ?? existing.generatedTitle ?? normalizeSessionTitle(existing.title),
				...(normalizedTitle && !existing.customTitle ? { generatedTitle: normalizedTitle } : {}),
				status: session.status,
				model: session.model ?? this.selectedModel,
				updatedAt: now,
				closed: false
			});
			return;
		}

		const normalizedTitle = title ? normalizeSessionTitle(title) : undefined;
		this.sessionTabs.unshift({
			id: session.id,
			title: normalizedTitle ?? defaultSessionTitle(),
			...(normalizedTitle ? { generatedTitle: normalizedTitle } : {}),
			createdAt: now,
			updatedAt: now,
			status: session.status,
			model: session.model ?? this.selectedModel,
			closed: false
		});

		while (this.sessionTabs.length > MAX_SESSIONS) {
			const removed = this.sessionTabs.pop();
			if (removed) {
				this.sessionStore.delete(removed.id);
			}
		}
	}

	/**
	 * Reassigns an existing tab �?and all of its transcript items �?from an old session id to a
	 * new one. Used when changing model/permission silently replaces the engine session: without
	 * this, every switch would orphan the old tab and unshift a fresh empty "鏂颁細璇?, which is the
	 * source of the stray, content-less tabs.
	 */
	private migrateSession(oldSessionId: string, newSession: IMicroClaudeSession): void {
		this.sessionStore.delete(oldSessionId);
		this.sessionStore.set(newSession.id, newSession);

		const tabIndex = this.sessionTabs.findIndex(candidate => candidate.id === oldSessionId);
		if (tabIndex >= 0) {
			this.sessionTabs.splice(tabIndex, 1, {
				...this.sessionTabs[tabIndex],
				id: newSession.id,
				status: newSession.status,
				model: newSession.model ?? this.selectedModel,
				updatedAt: Date.now()
			});
		} else {
			this.rememberSession(newSession);
		}
		this.mergeDuplicateSessionTabs(newSession.id);

		// Re-key transcript items, permissions and events so the conversation visibly continues
		// under the new session id (their sessionId is readonly, so replace the objects in place).
		reassignSessionId(this.messages, oldSessionId, newSession.id);
		reassignSessionId(this.permissions, oldSessionId, newSession.id);
		reassignSessionId(this.events, oldSessionId, newSession.id);
		const activeAssistant = this.activeAssistantMessageIds.get(oldSessionId);
		if (activeAssistant !== undefined) {
			this.activeAssistantMessageIds.delete(oldSessionId);
			this.activeAssistantMessageIds.set(newSession.id, activeAssistant);
		}
	}

	private mergeDuplicateSessionTabs(sessionId: string): void {
		let firstIndex = this.sessionTabs.findIndex(candidate => candidate.id === sessionId);
		if (firstIndex === -1) {
			return;
		}

		for (let index = this.sessionTabs.length - 1; index > firstIndex; index--) {
			const duplicate = this.sessionTabs[index];
			if (duplicate.id !== sessionId) {
				continue;
			}

			const current = this.sessionTabs[firstIndex];
			this.sessionTabs.splice(firstIndex, 1, {
				...duplicate,
				...current,
				title: current.customTitle ? current.title : current.title || duplicate.title,
				customTitle: current.customTitle ?? duplicate.customTitle,
				generatedTitle: current.generatedTitle ?? duplicate.generatedTitle,
				createdAt: Math.min(current.createdAt, duplicate.createdAt),
				updatedAt: Math.max(current.updatedAt, duplicate.updatedAt),
				closed: current.closed && duplicate.closed
			});
			this.sessionTabs.splice(index, 1);
			firstIndex = this.sessionTabs.findIndex(candidate => candidate.id === sessionId);
		}
	}

	private touchSession(sessionId: string | null | undefined, title?: string, status?: string): void {
		if (!sessionId) {
			return;
		}
		this.updateSessionTab(sessionId, {
			title,
			status,
			updatedAt: Date.now()
		});
	}

	private sessionHasContent(sessionId: string): boolean {
		return this.messages.some(message => message.sessionId === sessionId);
	}

	private removeSession(sessionId: string): void {
		this.sessionStore.delete(sessionId);
		const tabIndex = this.sessionTabs.findIndex(tab => tab.id === sessionId);
		if (tabIndex >= 0) {
			this.sessionTabs.splice(tabIndex, 1);
		}
		removeSessionItems(this.messages, sessionId);
		removeSessionItems(this.permissions, sessionId);
		removeSessionItems(this.events, sessionId);
	}

	private pickNextOpenSessionTab(closingSessionId: string): IMicroIDEAgentSessionTab | undefined {
		const displayTabs = this.sessionTabs
			.filter(tab => !tab.closed)
			.slice()
			.sort((a, b) => a.createdAt - b.createdAt);
		const index = displayTabs.findIndex(tab => tab.id === closingSessionId);
		if (index === -1) {
			return displayTabs[displayTabs.length - 1];
		}
		return displayTabs[index + 1] ?? displayTabs[index - 1];
	}

	private updateSessionTab(sessionId: string, update: Partial<Omit<IMicroIDEAgentSessionTab, 'id' | 'createdAt'>>): void {
		const index = this.sessionTabs.findIndex(tab => tab.id === sessionId);
		if (index === -1) {
			return;
		}

		const current = this.sessionTabs[index];
		this.sessionTabs.splice(index, 1, {
			...current,
			...update
		});
	}

	private getSessionTabs(): readonly IMicroIDEAgentSessionTab[] {
		return this.sessionTabs.slice();
	}

	private pushMessage(
		role: IMicroIDEAgentMessage['role'],
		text: string,
		state: MicroIDEAgentMessageState,
		sessionId: string | null,
		details: Omit<Partial<IMicroIDEAgentMessage>, 'id' | 'sessionId' | 'role' | 'text' | 'createdAt' | 'state'> = {}
	): IMicroIDEAgentMessage {
		const message: IMicroIDEAgentMessage = {
			id: this.nextId('message'),
			sessionId,
			role,
			text,
			createdAt: Date.now(),
			state,
			...details
		};
		pushLimited(this.messages, message, MAX_MESSAGES);
		if (sessionId) {
			// Lazily materialise the tab on first content. A user message names the tab; any
			// other first message falls back to the default title.
			const hasTab = this.sessionTabs.some(tab => tab.id === sessionId);
			if (!hasTab) {
				const session = this.sessionStore.get(sessionId);
				const title = role === 'user' ? truncateSingleLine(text, 36) || undefined : undefined;
				if (session) {
					this.rememberSession(session, title);
				}
			} else {
				const existingTab = this.sessionTabs.find(tab => tab.id === sessionId);
				const title = role === 'user' && existingTab && !existingTab.customTitle && isUntitledSessionTitle(existingTab.title)
					? truncateSingleLine(text, 36) || defaultSessionTitle()
					: undefined;
				this.touchSession(
					sessionId,
					title,
					state === 'error' ? 'error' : undefined
				);
			}
			this.refreshSessionStats(sessionId);
		}
		this.emitState();
		return message;
	}

	private findToolMessage(toolUseId: string): IMicroIDEAgentMessage | undefined {
		return this.messages.find(candidate => candidate.role === 'tool' && candidate.toolUseId === toolUseId);
	}

	private replaceMessage(messageId: string, message: IMicroIDEAgentMessage): void {
		const index = this.messages.findIndex(candidate => candidate.id === messageId);
		if (index === -1) {
			return;
		}
		this.messages[index] = message;
		if (message.sessionId) {
			this.refreshSessionStats(message.sessionId);
		}
		this.emitState();
	}

	private markActiveAssistantError(sessionId: string | null, message: string): void {
		const activeAssistantMessageId = sessionId ? this.activeAssistantMessageIds.get(sessionId) : undefined;
		const active = this.messages.find(candidate => candidate.id === activeAssistantMessageId);
		if (!active) {
			this.pushMessage('assistant', message, 'error', sessionId);
			if (sessionId) {
				this.activeAssistantMessageIds.delete(sessionId);
			}
			return;
		}

		this.replaceMessage(active.id, {
			...active,
			text: active.text ? `${active.text}\n\n${message}` : message,
			state: 'error'
		});
		if (sessionId) {
			this.activeAssistantMessageIds.delete(sessionId);
		}
	}

	private completeActiveAssistantMessage(sessionId: string | null): void {
		const activeAssistantMessageId = sessionId ? this.activeAssistantMessageIds.get(sessionId) : undefined;
		const active = this.messages.find(candidate => candidate.id === activeAssistantMessageId);
		if (active) {
			this.replaceMessage(active.id, {
				...active,
				state: 'complete'
			});
		}
		if (sessionId) {
			this.activeAssistantMessageIds.delete(sessionId);
		}
	}

	private markActiveAssistantInterrupted(sessionId: string | null): void {
		const activeAssistantMessageId = sessionId ? this.activeAssistantMessageIds.get(sessionId) : undefined;
		const active = this.messages.find(candidate => candidate.id === activeAssistantMessageId);
		if (active) {
			this.replaceMessage(active.id, {
				...active,
				text: active.text || localize('microide.interruptedAssistantMessage', "Interrupted before a final answer was generated."),
				state: 'complete'
			});
		}
		if (sessionId) {
			this.activeAssistantMessageIds.delete(sessionId);
		}
	}

	private updatePermission(requestId: string, state: MicroIDEPermissionState, reason?: string): void {
		const index = this.permissions.findIndex(request => request.requestId === requestId);
		if (index === -1) {
			return;
		}

		this.permissions[index] = {
			...this.permissions[index],
			state,
			reason,
			resolvedAt: Date.now()
		};
		if (this.permissions[index].sessionId) {
			this.refreshSessionStats(this.permissions[index].sessionId);
		}
		this.emitState();
	}

	private beginTurn(sessionId: string): void {
		const now = Date.now();
		this.turnStatus = {
			sessionId,
			phase: 'sending',
			startedAt: now,
			updatedAt: now,
			pendingPermissionCount: this.pendingPermissionCountForSession(sessionId)
		};
	}

	private updateTurnStatus(sessionId: string | null, phase: MicroIDETurnPhase, currentToolName?: string, currentToolSummary?: string): void {
		if (!sessionId) {
			return;
		}
		const now = Date.now();
		const current = this.turnStatus?.sessionId === sessionId ? this.turnStatus : undefined;
		const pendingPermissionCount = this.pendingPermissionCountForSession(sessionId);
		const nextToolName = currentToolName ?? current?.currentToolName;
		const nextToolSummary = currentToolSummary ?? current?.currentToolSummary;
		if (
			current
			&& current.phase === phase
			&& current.currentToolName === nextToolName
			&& current.currentToolSummary === nextToolSummary
			&& current.pendingPermissionCount === pendingPermissionCount
		) {
			return;
		}
		this.turnStatus = {
			sessionId,
			phase,
			startedAt: current?.startedAt ?? now,
			updatedAt: now,
			currentToolName: nextToolName,
			currentToolSummary: nextToolSummary,
			pendingPermissionCount
		};
		this.emitState();
	}

	private finishTurn(sessionId: string | null, phase: Extract<MicroIDETurnPhase, 'done' | 'interrupted' | 'error'>): void {
		if (!sessionId) {
			return;
		}
		const current = this.turnStatus?.sessionId === sessionId ? this.turnStatus : undefined;
		if (current && (current.phase === 'done' || current.phase === 'interrupted' || current.phase === 'error')) {
			return;
		}
		const now = Date.now();
		this.turnStatus = {
			sessionId,
			phase,
			startedAt: current?.startedAt ?? now,
			updatedAt: now,
			currentToolName: current?.currentToolName,
			currentToolSummary: current?.currentToolSummary,
			pendingPermissionCount: this.pendingPermissionCountForSession(sessionId)
		};
		this.refreshSessionStats(sessionId);
	}

	private pendingPermissionCountForSession(sessionId: string): number {
		return this.permissions.reduce((count, request) => count + (request.sessionId === sessionId && request.state === 'pending' ? 1 : 0), 0);
	}

	private refreshSessionStats(sessionId: string): void {
		const tab = this.sessionTabs.find(candidate => candidate.id === sessionId);
		if (!tab) {
			return;
		}
		const sessionMessages = this.messages.filter(message => message.sessionId === sessionId);
		const userMessages = sessionMessages.filter(message => message.role === 'user');
		const tools = sessionMessages.filter(message => message.role === 'tool');
		const titleSource = userMessages[userMessages.length - 1]?.text;
		const changedFiles = new Set(tools.map(message => message.diff?.filePath).filter((path): path is string => !!path));
		this.updateSessionTab(sessionId, {
			summary: titleSource ? truncateSingleLine(titleSource, 72) : tab.summary,
			toolCount: tools.length,
			commandCount: tools.filter(message => message.toolEffect === 'command').length,
			changedFileCount: changedFiles.size,
			permissionCount: this.permissions.filter(request => request.sessionId === sessionId).length
		});
	}

	private pushEvent(severity: MicroIDEAgentEventSeverity, title: string, detail: string | undefined, sessionId: string | null): void {
		pushLimited(this.events, {
			id: this.nextId('event'),
			sessionId,
			title,
			detail,
			severity,
			createdAt: Date.now()
		}, MAX_EVENTS);
		this.touchSession(sessionId, undefined, severity === 'error' ? 'error' : undefined);
		this.logService.trace(`[microide] ${title}${detail ? `: ${detail}` : ''}`);
		this.emitState();
	}

	private setStatus(status: MicroIDEAgentStatus): void {
		this.status = status;
		this.emitState();
	}

	private emitState(): void {
		this._onDidChangeState.fire(this.getState());
		if (!this.persistScheduler.isScheduled()) {
			this.persistScheduler.schedule();
		}
	}

	private restorePersistedState(): void {
		try {
			const raw = this.storageService.get(STORAGE_KEY, StorageScope.WORKSPACE);
			if (!raw) {
				return;
			}
			const parsed = JSON.parse(raw) as IPersistedAgentState;
			if (!parsed || !Array.isArray(parsed.tabs)) {
				return;
			}
			for (const session of parsed.sessions ?? []) {
				if (session && typeof session.id === 'string') {
					this.sessionStore.set(session.id, session);
				}
			}
			for (const message of parsed.messages ?? []) {
				if (message && typeof message.id === 'string') {
					this.messages.push(message);
				}
			}
			// Only restore tabs that actually carry conversation history. Empty "鏂颁細璇? tabs are
			// transient (e.g. left over from model/permission session swaps) and must not pile up
			// as blank, clickable-but-empty tabs on the next launch.
			const sessionsWithMessages = new Set(this.messages.map(message => message.sessionId).filter((id): id is string => !!id));
			for (const tab of parsed.tabs) {
				if (tab && typeof tab.id === 'string' && sessionsWithMessages.has(tab.id)) {
					this.sessionTabs.push(tab);
				}
			}
		} catch (error) {
			this.logService.warn(`[microide] failed to restore persisted agent state: ${toErrorMessage(error)}`);
		}
	}

	private persistState(): void {
		try {
			// Persist only resolved conversation messages (a streaming assistant
			// message will be re-driven by the live turn, never from storage).
			const persistedMessages = this.messages
				.filter(message => message.state !== 'streaming')
				.slice(-MAX_PERSISTED_MESSAGES_PER_SESSION * MAX_SESSIONS);
			const payload: IPersistedAgentState = {
				tabs: this.sessionTabs,
				sessions: Array.from(this.sessionStore.values()),
				messages: persistedMessages
			};
			this.storageService.store(STORAGE_KEY, JSON.stringify(payload), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		} catch (error) {
			this.logService.warn(`[microide] failed to persist agent state: ${toErrorMessage(error)}`);
		}
	}

	private nextId(prefix: string): string {
		return `${prefix}-${Date.now()}-${++this.sequence}`;
	}

	private getWorkspacePath(): string | undefined {
		const workspace = this.workspaceContextService.getWorkspace();
		const firstFolder = workspace.folders[0];
		return firstFolder?.uri.fsPath || firstFolder?.uri.path || undefined;
	}

	private normalizeSelectedModel(modelId: string | null | undefined): string | null {
		const trimmed = modelId?.trim();
		if (!trimmed) {
			return null;
		}

		// Custom models are valid selections even though they are not in the engine config.
		if (this.customModels.some(model => model.id === trimmed)) {
			return trimmed;
		}

		const models = this.configuration?.models;
		if (!models?.length) {
			return trimmed;
		}

		return models.some(model => model.id === trimmed) ? trimmed : models[0].id;
	}

	private assertAuthenticated(): void {
		return;
	}

}

function filterSessionItems<T extends { readonly sessionId: string | null }>(items: readonly T[], sessionId: string | null): T[] {
	if (!sessionId) {
		return items.filter(item => item.sessionId === null);
	}

	return items.filter(item => item.sessionId === sessionId || item.sessionId === null);
}

function removeSessionItems<T extends { readonly sessionId: string | null }>(items: T[], sessionId: string | null): void {
	for (let index = items.length - 1; index >= 0; index--) {
		if (sessionId ? items[index].sessionId === sessionId : items[index].sessionId === null) {
			items.splice(index, 1);
		}
	}
}

function normalizeSlashCommandList(commands: readonly IMicroClaudeSlashCommand[]): IMicroClaudeSlashCommand[] {
	const seen = new Set<string>();
	const normalized: IMicroClaudeSlashCommand[] = [];
	for (const command of commands) {
		const name = command.name.replace(/^\//, '').trim();
		if (!name || seen.has(name)) {
			continue;
		}
		seen.add(name);
		normalized.push({
			name,
			description: command.description || '',
			argumentHint: command.argumentHint || ''
		});
	}
	return normalized;
}

function mergeRuntimeModels(configuration: IMicroClaudeConfiguration | null, runtimeModels: readonly IMicroClaudeModelConfiguration[], selectedModel: string | null): IMicroClaudeConfiguration {
	const existingModels = configuration?.models ?? [];
	const existingById = new Map(existingModels.map(model => [model.id, model]));
	const models: IMicroClaudeModelConfiguration[] = [];
	const seen = new Set<string>();

	for (const runtimeModel of runtimeModels) {
		const existing = existingById.get(runtimeModel.id);
		models.push(existing ? { ...existing, ...runtimeModel, custom: existing.custom ?? runtimeModel.custom } : runtimeModel);
		seen.add(runtimeModel.id);
	}

	for (const existing of existingModels) {
		if (!seen.has(existing.id)) {
			models.push(existing);
		}
	}

	const fallback = models[0]?.id ?? selectedModel ?? configuration?.selectedModel ?? configuration?.defaultModel ?? 'default';
	return {
		...(configuration?.configPath ? { configPath: configuration.configPath } : {}),
		...(configuration?.baseUrl ? { baseUrl: configuration.baseUrl } : {}),
		defaultModel: configuration?.defaultModel ?? fallback,
		selectedModel: selectedModel ?? configuration?.selectedModel ?? fallback,
		models
	};
}

function normalizeRuntimeEffort(value: MicroClaudeEffortValue | string | null | undefined): MicroIDEEffortLevel | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const normalized = value.trim().toLowerCase().replace(/^extra-high$/, 'xhigh');
	if (
		normalized === 'low' ||
		normalized === 'medium' ||
		normalized === 'high' ||
		normalized === 'xhigh' ||
		normalized === 'max' ||
		normalized === 'ultracode'
	) {
		return normalized;
	}
	return undefined;
}

function normalizePermissionRequest(event: IMicroClaudeSidecarEvent): IMicroIDEPermissionRequest {
	const payload = asRecord(event.payload);
	const rawRequest = asRecord(payload?.request);
	const input = rawRequest?.input ?? rawRequest?.tool_input ?? rawRequest?.parameters;
	const inputRecord = asRecord(input);
	const toolName = getStringField(rawRequest, 'tool_name')
		?? getStringField(rawRequest, 'toolName')
		?? getStringField(rawRequest, 'name')
		?? getStringField(inputRecord, 'tool')
		?? localize('microide.unknownToolName', "Unknown tool");
	const command = getStringField(rawRequest, 'command')
		?? getStringField(inputRecord, 'command')
		?? getStringField(inputRecord, 'cmd')
		?? getStringField(inputRecord, 'script');
	const path = getStringField(rawRequest, 'path')
		?? getStringField(rawRequest, 'file_path')
		?? getStringField(inputRecord, 'path')
		?? getStringField(inputRecord, 'file_path')
		?? getStringField(inputRecord, 'filePath');
	const summary = getStringField(rawRequest, 'description')
		?? getStringField(rawRequest, 'summary')
		?? command
		?? path
		?? formatCompactJson(input || rawRequest || payload)
		?? localize('microide.permissionSummaryFallback', "Permission request");
	const requestId = getStringField(payload, 'requestId') ?? getStringField(payload, 'request_id') ?? `permission-${Date.now()}`;
	const output = rawRequest?.output ?? rawRequest?.tool_output ?? payload?.output ?? payload?.result;
	const diff = buildDiffPreview(toolName, input, output ?? rawRequest ?? payload);

	return {
		id: `permission-${requestId}`,
		requestId,
		sessionId: event.sessionId,
		toolName,
		summary,
		path,
		command,
		input,
		...(diff ? { diff } : {}),
		raw: payload?.raw ?? payload,
		createdAt: Date.now(),
		state: 'pending'
	};
}

function summarizeToolUse(toolName: string, input: unknown, output?: unknown): { summary: string; path?: string; command?: string } {
	const inputRecord = asRecord(input);
	const outputRecord = extractToolOutputRecord(output);
	const command = getStringField(inputRecord, 'command')
		?? getStringField(inputRecord, 'cmd')
		?? getStringField(inputRecord, 'script');
	const path = getStringField(inputRecord, 'file_path')
		?? getStringField(inputRecord, 'filePath')
		?? getStringField(inputRecord, 'path')
		?? getStringField(inputRecord, 'notebook_path')
		?? getStringField(outputRecord, 'filePath')
		?? getStringField(outputRecord, 'file_path');
	const lowerToolName = toolName.toLowerCase();
	let summary = toolName;

	if (command && (lowerToolName.includes('bash') || lowerToolName.includes('shell') || lowerToolName.includes('powershell'))) {
		summary = `${toolName} ${truncateSingleLine(command, 90)}`;
	} else if (path) {
		summary = `${toolVerb(toolName)} ${path}`;
	} else {
		const compact = formatCompactJson(input);
		if (compact) {
			summary = `${toolName} ${truncateSingleLine(compact, 90)}`;
		}
	}

	return {
		summary,
		...(path ? { path } : {}),
		...(command ? { command } : {})
	};
}

function classifyToolEffect(toolName: string, input: unknown, output: unknown, hasDiff: boolean): MicroIDEToolEffect {
	const lowerToolName = toolName.toLowerCase();
	const inputRecord = asRecord(input);
	const outputRecord = extractToolOutputRecord(output);
	if (hasDiff || isLikelyEditTool(toolName, inputRecord, outputRecord)) {
		return 'edit';
	}
	if (lowerToolName.includes('bash') || lowerToolName.includes('shell') || lowerToolName.includes('powershell') || lowerToolName.includes('terminal')) {
		return 'command';
	}
	if (lowerToolName.includes('web') || lowerToolName.includes('browser') || lowerToolName.includes('fetch') || lowerToolName.includes('search') || lowerToolName.includes('mcp')) {
		return 'network';
	}
	if (lowerToolName.includes('memory') || lowerToolName.includes('knowledge')) {
		return 'memory';
	}
	if (lowerToolName.includes('read') || lowerToolName.includes('grep') || lowerToolName.includes('glob') || lowerToolName.includes('list') || lowerToolName.includes('file')) {
		return 'read';
	}
	const command = getStringField(inputRecord, 'command')
		?? getStringField(inputRecord, 'cmd')
		?? getStringField(inputRecord, 'script');
	if (command) {
		return 'command';
	}
	return 'other';
}

function buildDiffPreview(toolName: string, input: unknown, output: unknown): IMicroIDEDiffPreview | undefined {
	const outputRecord = extractToolOutputRecord(output);
	const inputRecord = asRecord(input);
	const filePath = getStringField(outputRecord, 'filePath')
		?? getStringField(outputRecord, 'file_path')
		?? getStringField(inputRecord, 'file_path')
		?? getStringField(inputRecord, 'filePath')
		?? getStringField(inputRecord, 'path')
		?? getStringField(inputRecord, 'notebook_path');

	if (!filePath || !isLikelyEditTool(toolName, inputRecord, outputRecord)) {
		return undefined;
	}

	const structuredPatch = Array.isArray(outputRecord?.structuredPatch) ? outputRecord.structuredPatch : undefined;
	const outputType = getStringField(outputRecord, 'type');
	const outputContent = getStringField(outputRecord, 'content');
	const originalContent = getOriginalContent(inputRecord, outputRecord);
	const proposedContent = getProposedContent(inputRecord, outputRecord);
	const lowerToolName = toolName.toLowerCase();
	const isNewFile = outputType === 'create' || lowerToolName.includes('create');
	const hunkCandidates = structuredPatch?.length
		? structuredPatch
		: createFallbackHunks(inputRecord, outputContent, isNewFile);

	if (!hunkCandidates?.length) {
		return undefined;
	}

	const hunks = hunkCandidates.map(normalizeDiffHunk).filter((hunk): hunk is NonNullable<ReturnType<typeof normalizeDiffHunk>> => Boolean(hunk));
	if (!hunks.length) {
		return undefined;
	}

	const { added, removed } = countPreviewLines(hunks);
	return {
		filePath,
		summary: formatDiffSummary(added, removed, isNewFile),
		added,
		removed,
		isNewFile,
		...(originalContent !== undefined ? { originalContent } : {}),
		...(proposedContent !== undefined ? { proposedContent } : {}),
		hunks
	};
}

function getOriginalContent(input: Record<string, unknown> | undefined, output: Record<string, unknown> | undefined): string | undefined {
	return getStringField(output, 'originalContent')
		?? getStringField(output, 'original_content')
		?? getStringField(output, 'oldContent')
		?? getStringField(output, 'old_content')
		?? getStringField(input, 'originalContent')
		?? getStringField(input, 'original_content')
		?? getStringField(input, 'oldContent')
		?? getStringField(input, 'old_content');
}

function getProposedContent(input: Record<string, unknown> | undefined, output: Record<string, unknown> | undefined): string | undefined {
	return getStringField(output, 'proposedContent')
		?? getStringField(output, 'proposed_content')
		?? getStringField(output, 'newContent')
		?? getStringField(output, 'new_content')
		?? getStringField(output, 'content')
		?? getStringField(input, 'proposedContent')
		?? getStringField(input, 'proposed_content')
		?? getStringField(input, 'newContent')
		?? getStringField(input, 'new_content')
		?? getStringField(input, 'content')
		?? getStringField(input, 'fileContent')
		?? getStringField(input, 'file_content')
		?? getStringField(input, 'text');
}

function extractToolOutputRecord(output: unknown): Record<string, unknown> | undefined {
	const record = asRecord(output);
	if (!record) {
		return undefined;
	}
	const data = asRecord(record.data);
	return data ?? record;
}

function extractNestedRecord(value: unknown): Record<string, unknown> | undefined {
	if (Array.isArray(value)) {
		for (const item of value) {
			const record = extractNestedRecord(item);
			if (record) {
				return record;
			}
		}
		return undefined;
	}

	if (typeof value === 'string') {
		try {
			return asRecord(JSON.parse(value));
		} catch {
			return undefined;
		}
	}

	const record = asRecord(value);
	if (!record) {
		return undefined;
	}
	return asRecord(record.data) ?? record;
}

function upsertTeamMember(members: readonly IMicroIDEAgentTeamMember[], member: IMicroIDEAgentTeamMember): IMicroIDEAgentTeamMember[] {
	const existing = members.find(candidate => candidate.id === member.id);
	if (!existing) {
		return [...members, member];
	}
	return members.map(candidate => candidate.id === member.id ? { ...existing, ...member } : candidate);
}

function upsertTeamTask(tasks: readonly IMicroIDEAgentTeamTask[], task: IMicroIDEAgentTeamTask): IMicroIDEAgentTeamTask[] {
	const existing = tasks.find(candidate => candidate.id === task.id);
	if (!existing) {
		return [...tasks, task];
	}
	return tasks.map(candidate => candidate.id === task.id ? { ...existing, ...task } : candidate);
}

function normalizeTeamTaskFromTool(toolName: string | undefined, input: Record<string, unknown> | undefined, output: Record<string, unknown> | undefined): IMicroIDEAgentTeamTask | undefined {
	const taskRecord = asRecord(output?.task);
	const statusChange = asRecord(output?.statusChange);
	const taskId = getStringField(taskRecord, 'id')
		?? getStringField(output, 'taskId')
		?? getStringField(output, 'task_id')
		?? getStringField(input, 'taskId')
		?? getStringField(input, 'task_id');
	if (!taskId) {
		return undefined;
	}
	return {
		id: taskId,
		subject: getStringField(taskRecord, 'subject') ?? getStringField(input, 'subject') ?? taskId,
		status: getStringField(taskRecord, 'status')
			?? getStringField(statusChange, 'to')
			?? getStringField(input, 'status')
			?? getStringField(output, 'status')
			?? (toolName === 'TaskCreate' ? 'pending' : 'updated'),
		owner: getStringField(taskRecord, 'owner') ?? getStringField(input, 'owner') ?? getStringField(output, 'owner'),
		blockedBy: firstStringArray(taskRecord?.blockedBy, taskRecord?.blocked_by, input?.addBlockedBy, input?.add_blocked_by, output?.blockedBy, output?.blocked_by) ?? []
	};
}

function normalizeTeamTaskRecord(value: unknown): IMicroIDEAgentTeamTask | undefined {
	const record = asRecord(value);
	const id = getStringField(record, 'id') ?? getStringField(record, 'taskId') ?? getStringField(record, 'task_id');
	if (!id) {
		return undefined;
	}
	return {
		id,
		subject: getStringField(record, 'subject') ?? id,
		status: getStringField(record, 'status') ?? 'pending',
		owner: getStringField(record, 'owner'),
		blockedBy: firstStringArray(record?.blockedBy, record?.blocked_by) ?? []
	};
}

function teamToolMessageAttribution(toolName: string | undefined, input: unknown, output: unknown, currentTeamName: string | null): Partial<IMicroIDEAgentMessage> {
	if (!toolName || !isTeamToolName(toolName)) {
		return {};
	}

	const inputRecord = asRecord(input);
	const outputRecord = extractNestedRecord(output);
	const agentId = getStringField(outputRecord, 'agent_id')
		?? getStringField(outputRecord, 'agentId')
		?? getStringField(outputRecord, 'teammate_id')
		?? getStringField(outputRecord, 'teammateId')
		?? getStringField(inputRecord, 'agent_id')
		?? getStringField(inputRecord, 'agentId')
		?? getStringField(inputRecord, 'to');
	const agentName = getStringField(outputRecord, 'name')
		?? getStringField(inputRecord, 'name')
		?? getStringField(inputRecord, 'subagent_type')
		?? getStringField(inputRecord, 'agent_type')
		?? agentId;
	const teamName = getStringField(outputRecord, 'team_name')
		?? getStringField(outputRecord, 'teamName')
		?? getStringField(inputRecord, 'team_name')
		?? getStringField(inputRecord, 'teamName')
		?? currentTeamName
		?? undefined;

	return {
		...(agentId ? { agentId } : {}),
		...(agentName ? { agentName } : {}),
		...(teamName ? { teamName } : {})
	};
}

function isTeamToolName(toolName: string): boolean {
	return ['TeamCreate', 'TeamDelete', 'Agent', 'SendMessage', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'].includes(toolName);
}

function runtimeTaskStatus(eventName: string, status: string | undefined): string {
	if (status) {
		return status;
	}
	switch (eventName) {
		case 'task.notification':
			return 'completed';
		case 'task.started':
		case 'task.progress':
			return 'running';
		default:
			return 'pending';
	}
}

function stringifyTeamMessage(value: unknown): string | undefined {
	if (typeof value === 'string') {
		return value;
	}
	if (value === undefined || value === null) {
		return undefined;
	}
	return formatCompactJson(value);
}

function firstStringArray(...values: unknown[]): string[] | undefined {
	for (const value of values) {
		if (Array.isArray(value)) {
			return value.filter((item): item is string => typeof item === 'string');
		}
	}
	return undefined;
}

function isLikelyEditTool(toolName: string, input: Record<string, unknown> | undefined, output: Record<string, unknown> | undefined): boolean {
	const lowerToolName = toolName.toLowerCase();
	if (lowerToolName.includes('edit') || lowerToolName.includes('write') || lowerToolName.includes('create') || lowerToolName.includes('notebook')) {
		return true;
	}
	if (Array.isArray(output?.structuredPatch)) {
		return true;
	}
	return Boolean(input && (getStringField(input, 'old_string') || getStringField(input, 'new_string') || Array.isArray(input.edits)));
}

function createFallbackHunks(input: Record<string, unknown> | undefined, outputContent: string | undefined, isNewFile: boolean): unknown[] | undefined {
	const wholeFileContent = outputContent
		?? getStringField(input, 'content')
		?? getStringField(input, 'fileContent')
		?? getStringField(input, 'file_content')
		?? getStringField(input, 'text');

	if (wholeFileContent !== undefined && (isNewFile || !hasPatchShapedInput(input))) {
		const lines = splitLines(wholeFileContent).map(line => `+${line}`);
		return [{
			oldStart: 0,
			oldLines: 0,
			newStart: 1,
			newLines: lines.length,
			lines
		}];
	}

	if (!input) {
		return undefined;
	}

	const edits = Array.isArray(input.edits) ? input.edits : [input];
	const hunks = [];
	for (const edit of edits) {
		const editRecord = asRecord(edit);
		const oldString = getStringField(editRecord, 'old_string') ?? getStringField(editRecord, 'oldString');
		const newString = getStringField(editRecord, 'new_string') ?? getStringField(editRecord, 'newString');
		if (oldString === undefined && newString === undefined) {
			continue;
		}

		const oldLines = splitLines(oldString ?? '');
		const newLines = splitLines(newString ?? '');
		hunks.push({
			oldStart: 1,
			oldLines: oldLines.length,
			newStart: 1,
			newLines: newLines.length,
			lines: [
				...oldLines.map(line => `-${line}`),
				...newLines.map(line => `+${line}`)
			]
		});
	}

	return hunks.length ? hunks : undefined;
}

function hasPatchShapedInput(input: Record<string, unknown> | undefined): boolean {
	if (!input) {
		return false;
	}
	if (getStringField(input, 'old_string') !== undefined || getStringField(input, 'oldString') !== undefined || getStringField(input, 'new_string') !== undefined || getStringField(input, 'newString') !== undefined) {
		return true;
	}
	return Array.isArray(input.edits);
}

function normalizeDiffHunk(value: unknown): IMicroIDEDiffHunk | undefined {
	const record = asRecord(value);
	const lines = Array.isArray(record?.lines) ? record.lines.filter((line): line is string => typeof line === 'string') : undefined;
	if (!record || !lines?.length) {
		return undefined;
	}

	let oldLine = asNumber(record.oldStart) ?? 1;
	let newLine = asNumber(record.newStart) ?? 1;
	const normalizedLines = lines.map(rawLine => {
		const marker = rawLine.charAt(0);
		const text = marker === '+' || marker === '-' || marker === ' ' ? rawLine.slice(1) : rawLine;
		if (marker === '+') {
			return { kind: 'added' as const, newLine: newLine++, text };
		}
		if (marker === '-') {
			return { kind: 'removed' as const, oldLine: oldLine++, text };
		}
		return { kind: 'context' as const, oldLine: oldLine++, newLine: newLine++, text };
	});

	return {
		oldStart: asNumber(record.oldStart) ?? 1,
		oldLines: asNumber(record.oldLines) ?? normalizedLines.filter(line => line.kind !== 'added').length,
		newStart: asNumber(record.newStart) ?? 1,
		newLines: asNumber(record.newLines) ?? normalizedLines.filter(line => line.kind !== 'removed').length,
		lines: normalizedLines
	};
}

function countPreviewLines(hunks: readonly IMicroIDEDiffHunk[]): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const hunk of hunks) {
		for (const line of hunk.lines) {
			if (line.kind === 'added') {
				added++;
			} else if (line.kind === 'removed') {
				removed++;
			}
		}
	}
	return { added, removed };
}

function formatDiffSummary(added: number, removed: number, isNewFile: boolean): string {
	if (isNewFile) {
		return localize('microide.diffNewFileSummary', "Added {0} lines", added);
	}
	if (added && removed) {
		return localize('microide.diffChangedSummary', "Added {0}, removed {1}", added, removed);
	}
	if (added) {
		return localize('microide.diffAddedSummary', "Added {0} lines", added);
	}
	if (removed) {
		return localize('microide.diffRemovedSummary', "Removed {0} lines", removed);
	}
	return localize('microide.diffTouchedSummary', "File updated");
}

function toolVerb(toolName: string): string {
	const lowerToolName = toolName.toLowerCase();
	if (lowerToolName.includes('create')) {
		return localize('microide.toolVerbCreate', "Create");
	}
	if (lowerToolName.includes('write')) {
		return localize('microide.toolVerbWrite', "Write");
	}
	if (lowerToolName.includes('edit')) {
		return localize('microide.toolVerbEdit', "Edit");
	}
	if (lowerToolName.includes('read')) {
		return localize('microide.toolVerbRead', "Read");
	}
	return toolName;
}

function outputTextForEvent(output: unknown): string | undefined {
	if (typeof output === 'string') {
		return truncateMultiline(output, 2000);
	}
	const record = extractToolOutputRecord(output);
	const text = getStringField(record, 'stdout')
		?? getStringField(record, 'stderr')
		?? getStringField(record, 'content')
		?? getStringField(record, 'message');
	return text ? truncateMultiline(text, 2000) : formatCompactJson(output);
}

function truncateSingleLine(value: string, maxLength: number): string {
	const singleLine = value.replace(/\s+/g, ' ').trim();
	return singleLine.length > maxLength ? `${singleLine.slice(0, maxLength - 3)}...` : singleLine;
}

function defaultSessionTitle(): string {
	return localize('microide.defaultSessionTitle', "Untitled");
}

function isUntitledSessionTitle(value: string | undefined): boolean {
	const title = value?.trim().toLowerCase();
	return !title || title === 'untitled' || title === 'new session';
}

function normalizeSessionTitle(value: string | undefined): string {
	return isUntitledSessionTitle(value) ? defaultSessionTitle() : value!.trim();
}

function truncateMultiline(value: string, maxLength: number): string {
	return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function splitLines(value: string): string[] {
	if (!value) {
		return [];
	}
	return value.replace(/\r\n/g, '\n').split('\n');
}

function asNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asSession(value: unknown): IMicroIDEAgentState['session'] {
	const record = asRecord(value);
	const id = getStringField(record, 'id');
	if (!id) {
		return null;
	}

	return {
		id,
		workspace: getNullableStringField(record, 'workspace'),
		userDataDir: getNullableStringField(record, 'userDataDir'),
		projectDataDir: getNullableStringField(record, 'projectDataDir'),
		model: getNullableStringField(record, 'model'),
		mode: getStringField(record, 'mode') ?? 'agent',
		autoApprove: Boolean(record?.autoApprove),
		permissionMode: getNullableStringField(record, 'permissionMode'),
		status: getStringField(record, 'status') ?? 'ready',
		createdAt: getStringField(record, 'createdAt') ?? new Date().toISOString(),
		updatedAt: getStringField(record, 'updatedAt') ?? new Date().toISOString()
	};
}

function getStringField(record: Record<string, unknown> | undefined, field: string): string | undefined {
	const value = record?.[field];
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getNullableStringField(record: Record<string, unknown> | undefined, field: string): string | null {
	return getStringField(record, field) ?? null;
}

function permissionModeEventLabel(mode: MicroIDEPermissionMode): string {
	switch (mode) {
		case 'ask':
			return localize('microide.permissionModeEventAsk', "Ask for approval");
		case 'fullAccess':
			return localize('microide.permissionModeEventFullAccess', "Full access");
		default:
			return localize('microide.permissionModeEventAuto', "Auto");
	}
}

function agentModeEventLabel(mode: MicroIDEAgentMode): string {
	switch (mode) {
		case 'multiAgent':
			return localize('microide.agentModeEventMultiAgent', "Multi-Agent");
		case 'workflow':
			return localize('microide.agentModeEventWorkflow', "Workflow");
		default:
			return localize('microide.agentModeEventAgent', "Agent");
	}
}

function normalizeAgentMode(value: string | null | undefined): MicroIDEAgentMode | undefined {
	if (value === 'multiAgent' || value === 'workflow' || value === 'agent') {
		return value;
	}
	return undefined;
}

function formatCompactJson(value: unknown): string | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value === 'string') {
		return value;
	}
	try {
		const text = JSON.stringify(value, null, 2);
		return text.length > 2000 ? `${text.slice(0, 2000)}...` : text;
	} catch {
		return String(value);
	}
}

function reassignSessionId<T extends { readonly sessionId: string | null }>(items: T[], from: string, to: string): void {
	for (let index = 0; index < items.length; index++) {
		if (items[index].sessionId === from) {
			items[index] = { ...items[index], sessionId: to };
		}
	}
}

function allowRuleKey(toolName: string, command: string | undefined, path: string | undefined): string | undefined {
	const tool = toolName?.trim();
	if (!tool) {
		return undefined;
	}
	// Key on the tool plus its primary argument so "allow for project" matches the same
	// operation again (e.g. the same bash command or the same edited file), not every tool call.
	const arg = (command ?? path ?? '').trim();
	return `${tool}::${arg}`;
}

function toModelConfiguration(model: IMicroIDECustomModel): IMicroClaudeModelConfiguration {
	return {
		id: model.id,
		label: model.label || model.id,
		provider: localize('microide.customModelProvider', "Custom"),
		tier: localize('microide.customModelProvider', "Custom"),
		baseUrl: model.baseUrl,
		custom: true
	};
}

function pushLimited<T>(target: T[], item: T, limit: number): void {
	target.push(item);
	if (target.length > limit) {
		target.splice(0, target.length - limit);
	}
}

registerSingleton(IMicroIDEAgentService, MicroIDEAgentService, InstantiationType.Delayed);
