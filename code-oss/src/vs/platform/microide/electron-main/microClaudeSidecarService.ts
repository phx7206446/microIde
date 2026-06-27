/*---------------------------------------------------------------------------------------------
 *  Copyright (c) MicroIDE contributors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, readFileSync, readdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import type { Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { ILogService } from '../../log/common/log.js';
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
} from '../common/microClaudeProtocol.js';
import type { IMicroClaudeSidecarService } from '../common/microClaudeSidecarService.js';
import { MicroClaudeSidecarProcess, type IMicroClaudeSidecarProcessOptions } from './microClaudeSidecarProcess.js';

export class MicroClaudeSidecarService extends Disposable implements IMicroClaudeSidecarService {
	declare readonly _serviceBrand: undefined;

	private readonly process: MicroClaudeSidecarProcess;
	readonly onDidEmitEvent: Event<IMicroClaudeSidecarEvent>;

	constructor(
		@IEnvironmentMainService environmentMainService: IEnvironmentMainService,
		@ILogService logService: ILogService
	) {
		super();

		this.process = this._register(new MicroClaudeSidecarProcess(resolveSidecarOptions(environmentMainService), logService));
		this.onDidEmitEvent = this.process.onDidEmitEvent;
	}

	ping(): Promise<IMicroClaudePingResult> {
		return this.process.request<IMicroClaudePingResult>('sidecar.ping');
	}

	getCapabilities(): Promise<IMicroClaudeCapabilitiesResult> {
		return this.process.request<IMicroClaudeCapabilitiesResult>('sidecar.getCapabilities');
	}

	getConfiguration(): Promise<IMicroClaudeConfiguration> {
		return this.process.request<IMicroClaudeConfiguration>('sidecar.getConfiguration');
	}

	listCommands(params: IMicroClaudeListCommandsParams = {}): Promise<IMicroClaudeListCommandsResult> {
		return this.process.request<IMicroClaudeListCommandsResult>('commands.list', params);
	}

	listSkills(params: IMicroClaudeListSkillsParams = {}): Promise<IMicroClaudeListSkillsResult> {
		return this.process.request<IMicroClaudeListSkillsResult>('skills.list', params);
	}

	listPlugins(params: IMicroClaudeListPluginsParams = {}): Promise<IMicroClaudeListPluginsResult> {
		return this.process.request<IMicroClaudeListPluginsResult>('plugins.list', params);
	}

	installPlugin(params: IMicroClaudeInstallPluginParams): Promise<IMicroClaudeInstallPluginResult> {
		return this.process.request<IMicroClaudeInstallPluginResult>('plugins.install', params);
	}

	uninstallPlugin(params: IMicroClaudeUninstallPluginParams): Promise<IMicroClaudeUninstallPluginResult> {
		return this.process.request<IMicroClaudeUninstallPluginResult>('plugins.uninstall', params);
	}

	improvePrompt(params: IMicroClaudeImprovePromptParams): Promise<IMicroClaudeImprovePromptResult> {
		return this.process.request<IMicroClaudeImprovePromptResult>('prompt.improve', params);
	}

	listModels(params: IMicroClaudeListModelsParams = {}): Promise<IMicroClaudeListModelsResult> {
		return this.process.request<IMicroClaudeListModelsResult>('models.list', params);
	}

	setModel(params: IMicroClaudeSetModelParams): Promise<IMicroClaudeSetModelResult> {
		return this.process.request<IMicroClaudeSetModelResult>('model.set', params);
	}

	setThinking(params: IMicroClaudeSetThinkingParams): Promise<IMicroClaudeSetThinkingResult> {
		return this.process.request<IMicroClaudeSetThinkingResult>('thinking.set', params);
	}

	setEffort(params: IMicroClaudeSetEffortParams): Promise<IMicroClaudeSetEffortResult> {
		return this.process.request<IMicroClaudeSetEffortResult>('effort.set', params);
	}

	getModelSettings(params: IMicroClaudeModelSettingsParams): Promise<IMicroClaudeModelSettingsResult> {
		return this.process.request<IMicroClaudeModelSettingsResult>('modelSettings.get', params);
	}

	startSession(params: IMicroClaudeStartSessionParams): Promise<IMicroClaudeStartSessionResult> {
		return this.process.request<IMicroClaudeStartSessionResult>('session.start', params);
	}

	resumeSession(params: IMicroClaudeStartSessionParams & { readonly sessionId: string }): Promise<IMicroClaudeStartSessionResult> {
		return this.process.request<IMicroClaudeStartSessionResult>('session.resume', params);
	}

	sendMessage(params: IMicroClaudeSendMessageParams): Promise<IMicroClaudeSendMessageResult> {
		return this.process.request<IMicroClaudeSendMessageResult>('message.send', params);
	}

	cancelSession(sessionId: string): Promise<IMicroClaudeCancelSessionResult> {
		return this.process.request<IMicroClaudeCancelSessionResult>('session.cancel', { sessionId });
	}

	disposeSession(sessionId: string): Promise<IMicroClaudeDisposeSessionResult> {
		return this.process.request<IMicroClaudeDisposeSessionResult>('session.dispose', { sessionId });
	}

	resolvePermission(params: IMicroClaudeResolvePermissionParams): Promise<IMicroClaudeResolvePermissionResult> {
		return this.process.request<IMicroClaudeResolvePermissionResult>('permission.resolve', params);
	}
}

function resolveSidecarOptions(environmentMainService: IEnvironmentMainService): IMicroClaudeSidecarProcessOptions {
	const resourcesRoot = getResourcesRoot(environmentMainService);
	const microIdeRoot = process.env['MICROIDE_ROOT'] ?? getDevMicroIdeRoot();
	const releaseRoot = process.env['MICROIDE_RELEASE_ROOT'] ?? join(resourcesRoot, 'microide');
	const defaultRoot = environmentMainService.isBuilt ? releaseRoot : microIdeRoot;
	const sidecarRoot = process.env['MICROIDE_MICROCLAUDE_SIDECAR_ROOT'] ?? join(defaultRoot, 'sidecars', 'microclaude');
	const runtimePath = normalizeRuntimePath(
		process.env['MICROIDE_MICROCLAUDE_SIDECAR_RUNTIME'],
		environmentMainService,
		releaseRoot,
		microIdeRoot
	);
	const projectDataDir = process.env['MICROIDE_PROJECT_DATA_DIR'] ?? join(environmentMainService.userDataPath, 'microide');
	const configPath = process.env['MICROIDE_MICROCLAUDE_CONFIG'] ?? getDefaultConfigPath(environmentMainService, microIdeRoot, projectDataDir);
	const defaultConfigPath = process.env['MICROIDE_MICROCLAUDE_DEFAULT_CONFIG'] ?? getDefaultBundledConfigPath(environmentMainService, defaultRoot);

	return {
		runtimePath,
		entryPath: process.env['MICROIDE_MICROCLAUDE_SIDECAR_ENTRY'] ?? join(sidecarRoot, 'adapter', 'index.js'),
		sidecarRoot,
		workspace: process.env['MICROIDE_WORKSPACE'],
		userDataDir: process.env['MICROIDE_USER_DATA_DIR'] ?? environmentMainService.userDataPath,
		projectDataDir,
		engine: (process.env['MICROIDE_MICROCLAUDE_ENGINE'] as 'lightweight' | 'microclaude' | undefined) ?? getDefaultEngine(environmentMainService, defaultRoot),
		microClaudeCliPath: process.env['MICROIDE_MICROCLAUDE_CLI'] ?? join(defaultRoot, 'microClaude', 'cli.js'),
		microClaudeRuntimePath: normalizeRuntimePath(process.env['MICROIDE_MICROCLAUDE_RUNTIME'], environmentMainService, releaseRoot, microIdeRoot),
		configPath,
		defaultConfigPath,
		requestTimeoutMs: getNumberEnv('MICROIDE_MICROCLAUDE_REQUEST_TIMEOUT_MS') ?? getConfigRequestTimeoutMs(configPath, defaultConfigPath),
		env: {
			MICROIDE_RELEASE_ROOT: releaseRoot,
			MICROIDE_SIDECAR_ROOT: sidecarRoot,
			MICROIDE_USER_DATA_DIR: process.env['MICROIDE_USER_DATA_DIR'] ?? environmentMainService.userDataPath,
			MICROIDE_PROJECT_DATA_DIR: projectDataDir,
			MICROIDE_MICROCLAUDE_CONFIG: configPath,
			MICROIDE_MICROCLAUDE_DEFAULT_CONFIG: defaultConfigPath
		}
	};
}

function getResourcesRoot(environmentMainService: IEnvironmentMainService): string {
	if (process.env['MICROIDE_RESOURCES_ROOT']) {
		return process.env['MICROIDE_RESOURCES_ROOT'];
	}

	const electronProcess = process as NodeJS.Process & { readonly resourcesPath?: string };
	if (electronProcess.resourcesPath) {
		return electronProcess.resourcesPath;
	}

	return dirname(environmentMainService.appRoot);
}

function getDevMicroIdeRoot(): string {
	const cwd = process.cwd();
	for (const root of getCandidateRoots(process.cwd(), dirname(process.execPath))) {
		if (existsSync(join(root, 'sidecars', 'microclaude'))) {
			return root;
		}
	}

	return cwd;
}

function getDefaultRuntimePath(environmentMainService: IEnvironmentMainService, releaseRoot: string, microIdeRoot: string): string {
	if (environmentMainService.isBuilt) {
		const bundledRuntime = process.platform === 'win32'
			? join(releaseRoot, 'runtime', 'node.exe')
			: join(releaseRoot, 'runtime', 'bin', 'node');
		if (existsSync(bundledRuntime)) {
			return bundledRuntime;
		}
	}

	const devRuntime = getDevNodeRuntimePath(microIdeRoot);
	if (devRuntime) {
		return devRuntime;
	}

	if (isNodeRuntimePath(process.execPath)) {
		return process.execPath;
	}

	return process.platform === 'win32' ? 'node.exe' : 'node';
}

function normalizeRuntimePath(runtimePath: string | undefined, environmentMainService: IEnvironmentMainService, releaseRoot: string, microIdeRoot: string): string {
	if (!runtimePath || runtimePath === 'node' || runtimePath === 'node.exe') {
		return getDefaultRuntimePath(environmentMainService, releaseRoot, microIdeRoot);
	}

	return runtimePath;
}

function getDefaultEngine(environmentMainService: IEnvironmentMainService, defaultRoot: string): 'lightweight' | 'microclaude' {
	if (environmentMainService.isBuilt) {
		return 'microclaude';
	}

	return existsSync(join(defaultRoot, 'microClaude', 'cli.js')) ? 'microclaude' : 'lightweight';
}

function getDefaultConfigPath(environmentMainService: IEnvironmentMainService, microIdeRoot: string, projectDataDir: string): string {
	if (!environmentMainService.isBuilt) {
		return join(microIdeRoot, '.runtime', 'microide', 'microclaude.config.json');
	}

	return join(projectDataDir, 'microclaude.config.json');
}

function getDefaultBundledConfigPath(environmentMainService: IEnvironmentMainService, defaultRoot: string): string {
	if (!environmentMainService.isBuilt) {
		return join(defaultRoot, '.runtime', 'microide', 'microclaude.config.json');
	}

	return join(defaultRoot, 'defaults', 'microclaude.config.json');
}

function getDevNodeRuntimePath(microIdeRoot: string): string | undefined {
	const executable = process.platform === 'win32' ? 'node.exe' : 'bin/node';
	const roots = getCandidateRoots(microIdeRoot);

	for (const root of roots) {
		const toolsRoot = join(root, '.tools');
		if (!existsSync(toolsRoot)) {
			continue;
		}

		for (const entry of readdirSync(toolsRoot, { withFileTypes: true })) {
			if (!entry.isDirectory() || !entry.name.startsWith('node-')) {
				continue;
			}
			const candidate = join(toolsRoot, entry.name, executable);
			if (existsSync(candidate)) {
				return candidate;
			}
		}
	}

	return undefined;
}

function getCandidateRoots(...roots: string[]): string[] {
	const candidates = new Set<string>();
	for (const root of roots) {
		let current = resolve(root);
		for (let i = 0; i < 8; i++) {
			candidates.add(current);
			const parent = dirname(current);
			if (parent === current) {
				break;
			}
			current = parent;
		}
	}

	candidates.add(resolve(process.cwd()));
	return [...candidates];
}

function isNodeRuntimePath(runtimePath: string): boolean {
	const normalized = runtimePath.replace(/\\/g, '/').toLowerCase();
	return normalized.endsWith('/node') || normalized.endsWith('/node.exe');
}

function getNumberEnv(key: string): number | undefined {
	const value = process.env[key];
	if (!value) {
		return undefined;
	}

	return parsePositiveNumber(value);
}

function getConfigRequestTimeoutMs(configPath: string, defaultConfigPath: string): number | undefined {
	return getConfigNumber(configPath, 'API_TIMEOUT_MS') ?? getConfigNumber(defaultConfigPath, 'API_TIMEOUT_MS');
}

function getConfigNumber(configPath: string, envKey: string): number | undefined {
	if (!configPath || !existsSync(configPath)) {
		return undefined;
	}

	try {
		const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
		const env = isRecord(parsed) ? parsed['env'] : undefined;
		const value = isRecord(env) ? env[envKey] : undefined;
		return parsePositiveNumber(value);
	} catch {
		return undefined;
	}
}

function parsePositiveNumber(value: unknown): number | undefined {
	const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}
