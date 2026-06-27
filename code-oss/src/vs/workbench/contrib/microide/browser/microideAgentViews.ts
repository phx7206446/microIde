/*---------------------------------------------------------------------------------------------
 *  Copyright (c) MicroIDE contributors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import './media/microideAgent.css';

import { getZoomFactor } from '../../../../base/browser/browser.js';
import * as dom from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { VSBuffer, encodeBase64 } from '../../../../base/common/buffer.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService, type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IMarkdownRendererService } from '../../../../platform/markdown/browser/markdownRenderer.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import type { IMicroClaudeModelConfiguration, IMicroClaudePluginInfo, IMicroClaudeSkillInfo, IMicroClaudeSlashCommand } from '../../../../platform/microide/common/microClaudeProtocol.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { URI } from '../../../../base/common/uri.js';
import { isCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ISearchService } from '../../../services/search/common/search.js';
import { IMicroIDEDiffService } from './microideDiffService.js';
import { QueryBuilder } from '../../../services/search/common/queryBuilder.js';
import { ViewPane, type IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { BrowserViewSharingState, IBrowserViewWorkbenchService, type IBrowserViewModel } from '../../browserView/common/browserView.js';
import type { BrowserEditorInput } from '../../browserView/common/browserEditorInput.js';
import { IViewDescriptorService } from '../../../common/views.js';
import {
	IMicroIDEAgentService,
	MICROIDE_AGENT_PANEL_VIEW_ID
} from '../common/microideAgentService.js';
import type {
	IMicroIDEAgentMessage,
	IMicroIDEAgentSessionTab,
	IMicroIDEAgentState,
	IMicroIDEAgentTeamState,
	IMicroIDEAgentTeamTask,
	IMicroIDEDiffPreview,
	IMicroIDEFileContextAttachment,
	IMicroIDEImageAttachment,
	IMicroIDEPermissionRequest,
	IMicroIDETurnStatus,
	MicroIDEAgentMode,
	MicroIDEEffortLevel,
	MicroIDEToolEffect,
	MicroIDETurnPhase,
	MicroIDEPermissionMode
} from '../common/microideAgentService.js';

const REASONING_EFFORTS: readonly { readonly id: MicroIDEEffortLevel; readonly label: string }[] = [
	{ id: 'low', label: localize('microide.effortLow', "Low") },
	{ id: 'medium', label: localize('microide.effortMedium', "Medium") },
	{ id: 'high', label: localize('microide.effortHigh', "High") },
	{ id: 'xhigh', label: localize('microide.effortExtraHigh', "Extra high") },
	{ id: 'max', label: localize('microide.effortMax', "Max") },
	{ id: 'ultracode', label: localize('microide.effortUltracode', "Ultracode") }
] as const;

const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;
const IMAGE_ATTACHMENT_TOKEN_ESTIMATE = 1024;

type MicroIDECommandAction = 'attach-file' | 'mention-file' | 'clear-conversation' | 'switch-model' | 'account-usage' | 'toggle-thinking' | 'toggle-fast-mode' | 'insert-command';

const AGENT_MODE_OPTIONS: readonly { readonly id: MicroIDEAgentMode; readonly label: string; readonly description: string; readonly icon: ThemeIcon }[] = [
	{ id: 'agent', label: 'Agent', description: 'Single coding agent', icon: Codicon.agent },
	{ id: 'multiAgent', label: 'Multi-Agent', description: 'Coordinate specialist agents', icon: Codicon.organization },
	{ id: 'workflow', label: 'Workflow', description: 'Run a structured workflow', icon: Codicon.graph }
];


type MicroIDEWorkbenchSurface = 'task' | 'plugins' | 'automation';
type MicroIDETaskSidePanel = 'browser' | 'changes';
type MicroIDETaskCreationMode = 'working' | 'coding';

const MICROIDE_TASK_BROWSER_VIEW_ID = 'microworker.task.browser';

interface IMicroIDEWorkbenchNavItem {
	readonly id: MicroIDEWorkbenchSurface;
	readonly label: string;
	readonly description: string;
	readonly icon: ThemeIcon;
}

interface IMicroIDEWorkbenchCard {
	readonly title: string;
	readonly description: string;
	readonly meta: string;
	readonly icon: ThemeIcon;
	readonly prompt?: string;
	readonly actionLabel?: string;
}

interface IMicroIDETaskCategory {
	readonly label: string;
	readonly prompt: string;
}

const WORKBUDDY_NAV_ITEMS: readonly IMicroIDEWorkbenchNavItem[] = [
	{ id: 'task', label: localize('microide.workbuddy.newTask', "New Task"), description: localize('microide.workbuddy.newTaskDescription', "Start an agent run"), icon: Codicon.add },
	{ id: 'plugins', label: localize('microide.workbuddy.skillsNav', "Skills"), description: localize('microide.workbuddy.pluginsDescription', "Skill store and presets"), icon: Codicon.extensions },
	{ id: 'automation', label: localize('microide.workbuddy.automation', "Automation"), description: localize('microide.workbuddy.automationDescription', "Repeatable coding routines"), icon: Codicon.calendar }
];

const WORKBUDDY_WORKING_CATEGORIES: readonly IMicroIDETaskCategory[] = [
	{ label: localize('microide.workbuddy.categoryDocumentation', "Documentation"), prompt: 'Draft a concise workplace document for this task. Include goal, context, decisions, and next actions.' },
	{ label: localize('microide.workbuddy.categoryFinancialServices', "Financial Services"), prompt: 'Analyze this task as a financial-services workflow. Identify inputs, controls, risks, and the final deliverable.' },
	{ label: localize('microide.workbuddy.categoryWorkplaceHelper', "Workplace Helper"), prompt: 'Help organize this workplace task. Clarify the request, create a short plan, and produce an actionable output.' },
	{ label: localize('microide.workbuddy.categoryMore', "More"), prompt: 'Explore additional approaches for this task and suggest the best next action.' }
];

const WORKBUDDY_CODING_CATEGORIES: readonly IMicroIDETaskCategory[] = [
	{ label: localize('microide.workbuddy.categoryDailyDevelopment', "Daily Development"), prompt: 'Handle this daily development task. Inspect relevant files, make focused edits, and run the smallest useful verification.' },
	{ label: localize('microide.workbuddy.categoryWebsiteDevelopment', "Website Development"), prompt: 'Work on this website development task. Prioritize layout, responsive behavior, polish, and verification.' },
	{ label: localize('microide.workbuddy.categoryAgentApps', "Agent Apps"), prompt: 'Build or refine an agent-app workflow. Align the UI, tool states, and execution feedback.' },
	{ label: localize('microide.workbuddy.categoryMoreCoding', "More"), prompt: 'Explore additional coding approaches for this workspace and choose the safest implementation path.' }
];

const WORKBUDDY_PROMPT_STARTERS: readonly IMicroIDEWorkbenchCard[] = [
	{ title: localize('microide.workbuddy.promptReviewTitle', "Review current file"), description: localize('microide.workbuddy.promptReviewDescription', "Find risks, regressions, and missing tests."), meta: localize('microide.workbuddy.promptMetaCode', "Code"), icon: Codicon.shield, prompt: 'Review the current file for bugs, regressions, and missing tests. Prioritize concrete findings with file references.' },
	{ title: localize('microide.workbuddy.promptPlanTitle', "Plan a feature"), description: localize('microide.workbuddy.promptPlanDescription', "Break down implementation steps before editing."), meta: localize('microide.workbuddy.promptMetaPlanning', "Planning"), icon: Codicon.checklist, prompt: 'Plan the implementation for this feature in the current workspace. Identify files to inspect first, risks, and a minimal verification path.' },
	{ title: localize('microide.workbuddy.promptTestsTitle', "Create tests"), description: localize('microide.workbuddy.promptTestsDescription', "Add focused coverage for the active change."), meta: localize('microide.workbuddy.promptMetaQuality', "Quality"), icon: Codicon.beaker, prompt: 'Inspect the current change and add focused tests for the most important behavior. Keep the scope tight and run the relevant checks.' },
	{ title: localize('microide.workbuddy.promptDocsTitle', "Generate docs"), description: localize('microide.workbuddy.promptDocsDescription', "Turn implementation details into concise docs."), meta: localize('microide.workbuddy.promptMetaDocs', "Docs"), icon: Codicon.book, prompt: 'Draft concise developer documentation for the selected code or current feature. Include usage, constraints, and verification notes.' }
];

const WORKBUDDY_FALLBACK_INSTALLABLE_PLUGINS: readonly IMicroClaudePluginInfo[] = [
	{ id: 'frontend-design@claude-plugins-official', name: 'Frontend Design', description: localize('microide.workbuddy.pluginFrontendDesignDescription', "Create polished frontend interfaces and visual systems."), marketplace: 'claude-plugins-official', status: 'available', actionCommand: '/plugin install frontend-design@claude-plugins-official' },
	{ id: 'skill-creator@claude-plugins-official', name: 'Skill Creator', description: localize('microide.workbuddy.pluginSkillCreatorDescription', "Create or refine reusable agent skills."), marketplace: 'claude-plugins-official', status: 'available', actionCommand: '/plugin install skill-creator@claude-plugins-official' },
	{ id: 'playwright@claude-plugins-official', name: 'Playwright', description: localize('microide.workbuddy.pluginPlaywrightDescription', "Verify browser UI with screenshots and traces."), marketplace: 'claude-plugins-official', status: 'available', actionCommand: '/plugin install playwright@claude-plugins-official' },
	{ id: 'openclaw-video-toolkit@openclaw-skills', name: 'OpenClaw Video Toolkit', description: localize('microide.workbuddy.pluginOpenClawVideoDescription', "Generate voiceovers, scenes, and Remotion videos from prompts."), marketplace: 'openclaw-skills', status: 'available', actionCommand: '/plugin install openclaw-video-toolkit@openclaw-skills' }
];
const WORKBUDDY_AUTOMATION_CARDS: readonly IMicroIDEWorkbenchCard[] = [
	{ title: localize('microide.workbuddy.automationWeekly', "Weekly Work Report"), description: localize('microide.workbuddy.automationWeeklyDescription', "Summarize commits, merged PRs, and pending risks."), meta: localize('microide.workbuddy.automationWeeklyMeta', "Weekly"), icon: Codicon.graphLine, prompt: 'Create a weekly engineering work report template for this repository. Include commits, PRs, shipped work, blockers, and next steps.' },
	{ title: localize('microide.workbuddy.automationPrDigest', "PR Digest"), description: localize('microide.workbuddy.automationPrDigestDescription', "Collect changes, review notes, and verification status."), meta: localize('microide.workbuddy.automationDailyMeta', "Daily"), icon: Codicon.gitPullRequest, prompt: 'Build a PR digest workflow for this repository. Include changed areas, review risks, and verification commands.' },
	{ title: localize('microide.workbuddy.automationRelease', "Release Checklist"), description: localize('microide.workbuddy.automationReleaseDescription', "Prepare validation tasks before shipping."), meta: localize('microide.workbuddy.automationTemplateMeta', "Template"), icon: Codicon.checklist, prompt: 'Create a release checklist for this project, including build, tests, migration checks, rollout, and rollback steps.' },
	{ title: localize('microide.workbuddy.automationDependency', "Dependency Audit"), description: localize('microide.workbuddy.automationDependencyDescription', "Track outdated packages and risky updates."), meta: localize('microide.workbuddy.automationMonthlyMeta', "Monthly"), icon: Codicon.package, prompt: 'Design a dependency audit workflow for this project. Identify package managers, commands, risk levels, and reporting output.' }
];


interface IMicroIDESlashAction {
	readonly section: string;
	readonly label: string;
	readonly description?: string;
	readonly value?: string;
	readonly icon: ThemeIcon;
	readonly action: MicroIDECommandAction;
}

interface IMicroIDEMentionSuggestion {
	readonly path: string;
	readonly isDirectory: boolean;
}

interface IMicroIDEAskUserQuestionOption {
	readonly label: string;
	readonly description?: string;
	readonly preview?: string;
}

interface IMicroIDEAskUserQuestion {
	readonly question: string;
	readonly header?: string;
	readonly options: readonly IMicroIDEAskUserQuestionOption[];
	readonly multiSelect?: boolean;
}

interface IMicroIDEAskUserQuestionInput {
	readonly questions: readonly IMicroIDEAskUserQuestion[];
	readonly answers?: Record<string, string>;
	readonly annotations?: Record<string, unknown>;
	readonly metadata?: unknown;
}

export class MicroIDEAgentPanelView extends ViewPane {
	private root: HTMLElement | undefined;
	private statusElement: HTMLElement | undefined;
	private engineElement: HTMLElement | undefined;
	private transcriptElement: HTMLElement | undefined;
	private teamElement: HTMLElement | undefined;
	private taskSidePanelElement: HTMLElement | undefined;
	private composerElement: HTMLElement | undefined;
	private sideNavElement: HTMLElement | undefined;
	private surfaceElement: HTMLElement | undefined;
	private permissionPromptElement: HTMLElement | undefined;
	private tabsElement: HTMLElement | undefined;
	private historyPopoverElement: HTMLElement | undefined;
	private agentModeButton: HTMLButtonElement | undefined;
	private agentModePopoverElement: HTMLElement | undefined;
	private modelButton: HTMLButtonElement | undefined;
	private modelPopoverElement: HTMLElement | undefined;
	private inputElement: HTMLTextAreaElement | undefined;
	private contextMeterElement: HTMLElement | undefined;
	private commandPaletteElement: HTMLElement | undefined;
	private attachmentsElement: HTMLElement | undefined;
	private contextElement: HTMLElement | undefined;
	private mentionPopoverElement: HTMLElement | undefined;
	private skillsButton: HTMLButtonElement | undefined;
	private skillsPopoverElement: HTMLElement | undefined;
	private connectorsButton: HTMLButtonElement | undefined;
	private connectorsPopoverElement: HTMLElement | undefined;
	private workspaceButton: HTMLButtonElement | undefined;
	private workspacePopoverElement: HTMLElement | undefined;
	private queryBuilder: QueryBuilder | undefined;
	private mentionSearchCts: CancellationTokenSource | undefined;
	private taskStudioFileSearchCts: CancellationTokenSource | undefined;
	private taskStudioFileSearchElement: HTMLElement | undefined;
	private taskStudioFileContextsElement: HTMLElement | undefined;
	private permissionPopoverElement: HTMLElement | undefined;
	private turnButton: HTMLButtonElement | undefined;
	private permissionModeButton: HTMLButtonElement | undefined;
	private newSessionButton: HTMLButtonElement | undefined;
	private historyButton: HTMLButtonElement | undefined;
	private pendingAttachments: IMicroIDEImageAttachment[] = [];
	private pendingFileContexts: IMicroIDEFileContextAttachment[] = [];
	private activeEditorContextDisabledKey: string | undefined;
	private transcriptRenderer: TranscriptRenderer | undefined;
	private modelPopoverTab: 'models' | 'custom' = 'models';
	private sessionHistoryFilter = '';
	private mentionActiveIndex = 0;
	private activeWorkbenchSurface: MicroIDEWorkbenchSurface = 'task';
	private taskCreationMode: MicroIDETaskCreationMode = 'coding';
	private improvingPrompt = false;
	private showingNewTaskStudio = true;
	private taskSidePanelVisible = false;
	private taskSidePanelMode: MicroIDETaskSidePanel = 'browser';
	private taskBrowserUrl = 'about:blank';
	private taskBrowserStatus: 'idle' | 'opening' | 'opened' | 'error' = 'idle';
	private taskBrowserInput: BrowserEditorInput | undefined;
	private taskBrowserModel: IBrowserViewModel | undefined;
	private taskBrowserFrameElement: HTMLElement | undefined;
	private taskBrowserOpeningUrl: string | undefined;
	private taskBrowserSharingRequested = false;
	private installingPluginIds = new Set<string>();
	private uninstallingPluginIds = new Set<string>();
	private editingSessionId: string | undefined;
	private editingSessionSurface: 'tabs' | 'history' = 'tabs';
	private editingSessionValue = '';
	private readonly activeEditorSelectionDisposables = this._register(new DisposableStore());
	private readonly permissionPromptDisposables = this._register(new DisposableStore());
	private readonly taskSidePanelDisposables = this._register(new DisposableStore());
	private readonly taskBrowserModelDisposables = this._register(new DisposableStore());

	private readonly renderScheduler = this._register(new RunOnceScheduler(() => this.renderState(), 16));
	private readonly taskBrowserLayoutScheduler = this._register(new RunOnceScheduler(() => this.layoutTaskBrowserView(), 16));

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IMicroIDEAgentService private readonly microIDEAgentService: IMicroIDEAgentService,
		@INotificationService private readonly notificationService: INotificationService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IFileService private readonly fileService: IFileService,
		@ISearchService private readonly searchService: ISearchService,
		@IMarkdownRendererService private readonly markdownRendererService: IMarkdownRendererService,
		@IEditorService private readonly editorService: IEditorService,
		@IBrowserViewWorkbenchService private readonly browserViewWorkbenchService: IBrowserViewWorkbenchService,
		@IMicroIDEDiffService private readonly microIDEDiffService: IMicroIDEDiffService
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		this._register(this.microIDEAgentService.onDidChangeState(() => this.renderScheduler.schedule()));
		this._register(dom.addDisposableListener(mainWindow, 'resize', () => this.scheduleTaskBrowserLayout(0)));
		this._register(dom.addDisposableListener(mainWindow, 'focus', () => this.scheduleTaskBrowserLayout(0)));
		this._register(this.browserViewWorkbenchService.onDidChangeSharingAvailable(() => void this.shareTaskBrowserWithAgent()));
		this._register(this.editorService.onDidActiveEditorChange(() => {
			this.refreshActiveEditorSelectionListener();
			this.renderScheduler.schedule();
		}));
		this.refreshActiveEditorSelectionListener();
		void this.microIDEAgentService.ensureReady().catch(error => this.notificationService.error(toErrorMessage(error)));
	}

	override focus(): void {
		super.focus();
		this.inputElement?.focus();
	}

	override dispose(): void {
		this.hideTaskBrowserView();
		this.taskBrowserModelDisposables.clear();
		super.dispose();
	}

	private refreshActiveEditorSelectionListener(): void {
		this.activeEditorSelectionDisposables.clear();
		const control = this.editorService.activeTextEditorControl;
		if (!isCodeEditor(control)) {
			return;
		}
		this.activeEditorSelectionDisposables.add(control.onDidChangeCursorSelection(() => {
			this.renderFileContexts();
			this.renderContextMeter(this.microIDEAgentService.getState());
		}));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		this.root = dom.append(container, dom.$('.microide-agent-root'));
		this.root.addEventListener('keydown', event => this.handlePanelKeydown(event));
		this._register(dom.addDisposableListener(mainWindow, 'microide:openTaskSidePanel', event => {
			const mode = (event as CustomEvent<{ readonly mode?: MicroIDETaskSidePanel }>).detail?.mode === 'changes' ? 'changes' : 'browser';
			this.openTaskSidePanel(mode);
		}));

		const header = dom.append(this.root, dom.$('.microide-agent-header'));
		this.tabsElement = dom.append(header, dom.$('.microide-session-tabs'));
		const headerActions = dom.append(header, dom.$('.microide-session-actions'));
		this.historyButton = appendIconButton(headerActions, Codicon.history, localize('microide.sessionHistory', "Session history"), 'compact secondary icon-only');
		this.newSessionButton = appendIconButton(headerActions, Codicon.add, localize('microide.newSession', "New session"), 'compact secondary icon-only');
		this.statusElement = dom.append(headerActions, dom.$('.microide-agent-status'));
		this.historyPopoverElement = dom.append(header, dom.$('.microide-session-history-popover'));

		const shell = dom.append(this.root, dom.$('.microide-workbuddy-shell'));
		this.sideNavElement = dom.append(shell, dom.$('.microide-workbuddy-sidebar'));
		const main = dom.append(shell, dom.$('.microide-workbuddy-main'));

		this.engineElement = dom.append(main, dom.$('.microide-engine-strip'));

		const workbench = dom.append(main, dom.$('.microide-agent-workbench'));
		workbench.addEventListener('mousedown', () => this.closeOtherPopovers());
		this.surfaceElement = dom.append(workbench, dom.$('.microide-workbuddy-surface'));
		this.transcriptElement = dom.append(workbench, dom.$('.microide-agent-transcript'));
		this.teamElement = dom.append(workbench, dom.$('.microide-team-strip'));
		this.taskSidePanelElement = dom.append(workbench, dom.$('.microide-task-side-panel.hidden'));
		this.transcriptRenderer = this._register(new TranscriptRenderer(this.transcriptElement, {
			markdownRendererService: this.markdownRendererService,
			copyText: text => this.clipboardService.writeText(text),
			openPath: path => this.openWorkspacePath(path),
			openDiff: diff => this.openDiffInEditor(diff)
		}));

		this.permissionPromptElement = dom.append(main, dom.$('.microide-permission-prompt'));
		this.composerElement = dom.append(main, dom.$('.microide-agent-composer'));

		this.newSessionButton.addEventListener('click', () => this.showNewTaskStudio());
		this.historyButton.addEventListener('click', () => this.toggleHistoryPopover());
		this.renderState();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this.root) {
			this.root.style.height = `${height}px`;
			this.root.style.width = `${width}px`;
		}
	}

	private handlePanelKeydown(event: KeyboardEvent): void {
		if (event.defaultPrevented || event.key !== 'Escape') {
			return;
		}
		if (this.editingSessionId) {
			event.preventDefault();
			event.stopPropagation();
			this.cancelRenameSession();
			return;
		}
		if (!isTurnRunning(this.microIDEAgentService.getState())) {
			return;
		}
		if (this.permissionPromptElement?.classList.contains('visible')) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		void this.cancelPrompt();
	}

	private async selectModel(modelId: string): Promise<void> {
		this.modelPopoverElement?.classList.remove('visible');
		if (!modelId || modelId === this.microIDEAgentService.getState().selectedModel) {
			return;
		}

		if (this.modelButton) {
			this.modelButton.disabled = true;
		}
		try {
			await this.microIDEAgentService.setSelectedModel(modelId);
		} catch (error) {
			this.notificationService.error(toErrorMessage(error));
		} finally {
			this.renderState();
		}
	}

	private async openWorkspacePath(path: string): Promise<void> {
		const resource = this.resolvePathResource(path);
		if (!resource) {
			return;
		}
		try {
			await this.editorService.openEditor({ resource, options: { preserveFocus: false } });
		} catch (error) {
			this.notificationService.error(toErrorMessage(error));
		}
	}

	private async openDiffInEditor(diff: IMicroIDEDiffPreview): Promise<void> {
		try {
			await this.microIDEDiffService.openDiff(diff);
		} catch (error) {
			this.notificationService.error(toErrorMessage(error));
		}
	}

	private resolvePathResource(path: string): URI | undefined {
		const trimmed = path.trim();
		if (!trimmed) {
			return undefined;
		}
		// Absolute paths (POSIX or Windows) resolve directly; otherwise treat as
		// workspace-relative against the first workspace folder.
		if (/^([a-zA-Z]:[\\/]|[\\/])/.test(trimmed) || trimmed.startsWith('file:')) {
			try {
				return trimmed.startsWith('file:') ? URI.parse(trimmed) : URI.file(trimmed);
			} catch {
				return undefined;
			}
		}
		const folder = this.workspaceContextService.getWorkspace().folders[0];
		if (!folder) {
			return undefined;
		}
		return URI.joinPath(folder.uri, ...trimmed.split(/[\\/]+/));
	}

	private async submitPrompt(): Promise<void> {
		const input = this.inputElement;
		if (!input) {
			return;
		}

		const prompt = input.value.trim();
		const attachments = this.pendingAttachments.slice();
		this.syncPendingMentionContextsFromInput();
		const context = this.getSendableFileContexts();
		if (!prompt && !attachments.length) {
			return;
		}

		this.setComposerEnabled(false);
		try {
			await this.microIDEAgentService.sendPrompt(prompt, attachments, context);
			input.value = '';
			this.pendingAttachments = [];
			this.pendingFileContexts = [];
			this.renderAttachments();
			this.renderFileContexts();
		} catch (error) {
			this.notificationService.error(toErrorMessage(error));
		} finally {
			this.setComposerEnabled(true);
			this.renderState();
		}
	}

	private handleComposerPaste(event: ClipboardEvent): void {
		const items = event.clipboardData?.items;
		if (!items) {
			return;
		}
		for (const item of Array.from(items)) {
			if (item.kind === 'file' && item.type.startsWith('image/')) {
				const file = item.getAsFile();
				if (file) {
					event.preventDefault();
					void this.addImageFile(file);
				}
			}
		}
	}

	private handleComposerDrop(event: DragEvent): void {
		const files = event.dataTransfer?.files;
		if (!files?.length) {
			return;
		}
		const images = Array.from(files).filter(file => file.type.startsWith('image/'));
		if (!images.length) {
			return;
		}
		event.preventDefault();
		for (const file of images) {
			void this.addImageFile(file);
		}
	}

	private async addImageFile(file: File): Promise<void> {
		try {
			const buffer = await file.arrayBuffer();
			const data = encodeBase64(VSBuffer.wrap(new Uint8Array(buffer)));
			this.pendingAttachments.push({
				id: `attachment-${Date.now()}-${this.pendingAttachments.length}`,
				name: file.name || localize('microide.pastedImage', "Pasted image"),
				mediaType: file.type || 'image/png',
				data
			});
			this.renderAttachments();
		} catch (error) {
			this.notificationService.error(toErrorMessage(error));
		}
	}

	private removeAttachment(id: string): void {
		this.pendingAttachments = this.pendingAttachments.filter(attachment => attachment.id !== id);
		this.renderAttachments();
	}

	private removeFileContext(id: string): void {
		this.pendingFileContexts = this.pendingFileContexts.filter(context => context.id !== id);
		this.renderFileContexts();
	}

	private toggleActiveEditorContext(): void {
		const context = this.getActiveEditorContext();
		if (!context) {
			return;
		}
		this.activeEditorContextDisabledKey = context.enabled ? context.id : undefined;
		this.renderFileContexts();
	}

	private getActiveEditorContext(): IMicroIDEFileContextAttachment | undefined {
		const resource = this.editorService.activeEditor?.resource;
		if (!resource || resource.scheme !== 'file') {
			return undefined;
		}
		const path = this.toWorkspaceRelativePath(resource);
		const id = `active-editor:${resource.toString()}`;
		const selection = this.getActiveEditorSelectionSummary(resource);
		return {
			id,
			label: selection ? formatSelectedLines(selection.lineCount) : pathBasename(path),
			path,
			source: 'activeEditor',
			enabled: this.activeEditorContextDisabledKey !== id,
			...(selection ? {
				selectionLineCount: selection.lineCount,
				selectedTextLength: selection.textLength,
				selectionRanges: selection.ranges
			} : {})
		};
	}

	private getActiveEditorSelectionSummary(resource: URI): { readonly lineCount: number; readonly textLength: number; readonly ranges: readonly { readonly startLineNumber: number; readonly endLineNumber: number }[] } | undefined {
		const control = this.editorService.activeTextEditorControl;
		if (!isCodeEditor(control) || !control.hasModel() || control.getModel().uri.toString() !== resource.toString()) {
			return undefined;
		}
		const selections = control.getSelections()?.filter(selection => !selection.isEmpty()) ?? [];
		if (!selections.length) {
			return undefined;
		}

		const selectedLines = new Set<number>();
		const ranges: Array<{ startLineNumber: number; endLineNumber: number }> = [];
		let textLength = 0;
		for (const selection of selections) {
			let startLineNumber = Math.min(selection.startLineNumber, selection.endLineNumber);
			let endLineNumber = Math.max(selection.startLineNumber, selection.endLineNumber);
			if (selection.endLineNumber > selection.startLineNumber && selection.endColumn === 1) {
				endLineNumber--;
			}
			if (endLineNumber < startLineNumber) {
				continue;
			}
			for (let lineNumber = startLineNumber; lineNumber <= endLineNumber; lineNumber++) {
				selectedLines.add(lineNumber);
			}
			textLength += control.getModel().getValueInRange(selection).length;
			ranges.push({ startLineNumber, endLineNumber });
		}

		if (!selectedLines.size) {
			return undefined;
		}
		return {
			lineCount: selectedLines.size,
			textLength,
			ranges
		};
	}

	private getVisibleFileContexts(): readonly IMicroIDEFileContextAttachment[] {
		const active = this.getActiveEditorContext();
		return active ? [active, ...this.pendingFileContexts] : this.pendingFileContexts;
	}

	private getSendableFileContexts(): readonly IMicroIDEFileContextAttachment[] {
		const seen = new Set<string>();
		return this.getVisibleFileContexts().filter(context => {
			const key = `${context.source}:${context.path}`;
			if (!context.enabled || seen.has(key)) {
				return false;
			}
			seen.add(key);
			return true;
		});
	}

	private renderFileContexts(): void {
		const container = this.contextElement;
		if (!container) {
			return;
		}
		dom.reset(container);
		const contexts = this.getVisibleFileContexts().filter(context => context.source === 'activeEditor');
		container.classList.toggle('visible', contexts.length > 0);

		for (const context of contexts) {
			if (context.source === 'activeEditor') {
				const chip = dom.append(container, dom.$('button.microide-file-context-chip.microide-file-context-chip-active')) as HTMLButtonElement;
				chip.type = 'button';
				chip.classList.toggle('disabled', !context.enabled);
				chip.classList.toggle('selected', Boolean(context.selectionLineCount));
				chip.setAttribute('aria-pressed', String(context.enabled));
				chip.title = context.enabled
					? context.selectionLineCount
						? localize('microide.disableSelectedFileContext', "{0} from {1} is included as context. Click to turn it off.", formatSelectedLines(context.selectionLineCount), context.path)
						: localize('microide.disableCurrentFileContext', "Current file is included as context. Click to turn it off.")
					: localize('microide.enableCurrentFileContext', "Current file context is turned off. Click to include it again.");
				appendIcon(chip, context.enabled ? Codicon.file : Codicon.eyeClosed);
				const label = dom.append(chip, dom.$('span.microide-file-context-label'));
				label.textContent = context.label;
				chip.addEventListener('click', () => this.toggleActiveEditorContext());
			} else {
				const chip = dom.append(container, dom.$('.microide-file-context-chip')) as HTMLElement;
				chip.title = context.path;
				appendIcon(chip, Codicon.file);
				const label = dom.append(chip, dom.$('span.microide-file-context-label'));
				label.textContent = context.label;
				const remove = dom.append(chip, dom.$('button.microide-file-context-remove')) as HTMLButtonElement;
				remove.type = 'button';
				remove.title = localize('microide.removeFileContext', "Remove file context");
				appendIcon(remove, Codicon.close);
				remove.addEventListener('click', () => this.removeFileContext(context.id));
			}
		}
		this.renderContextMeter(this.microIDEAgentService.getState());
	}

	private renderAttachments(): void {
		const container = this.attachmentsElement;
		if (!container) {
			return;
		}
		dom.reset(container);
		container.classList.toggle('visible', this.pendingAttachments.length > 0);
		for (const attachment of this.pendingAttachments) {
			const chip = dom.append(container, dom.$('.microide-attachment-chip'));
			const thumb = dom.append(chip, dom.$('img.microide-attachment-thumb')) as HTMLImageElement;
			thumb.src = `data:${attachment.mediaType};base64,${attachment.data}`;
			thumb.alt = attachment.name;
			const name = dom.append(chip, dom.$('span.microide-attachment-name'));
			name.textContent = attachment.name;
			const remove = dom.append(chip, dom.$('button.microide-attachment-remove')) as HTMLButtonElement;
			remove.type = 'button';
			remove.title = localize('microide.removeAttachment', "Remove attachment");
			appendIcon(remove, Codicon.close);
			remove.addEventListener('click', () => this.removeAttachment(attachment.id));
		}
		this.updateTurnButtonState();
		this.renderContextMeter(this.microIDEAgentService.getState());
	}

	private async cancelPrompt(): Promise<void> {
		try {
			await this.microIDEAgentService.cancelActiveSession();
		} catch (error) {
			this.notificationService.error(toErrorMessage(error));
		}
	}

	private async switchSession(sessionId: string): Promise<void> {
		this.activeWorkbenchSurface = 'task';
		this.showingNewTaskStudio = false;
		try {
			await this.microIDEAgentService.switchSession(sessionId);
			this.historyPopoverElement?.classList.remove('visible');
		} catch (error) {
			this.notificationService.error(toErrorMessage(error));
		} finally {
			this.renderState();
		}
	}

	private async closeSession(sessionId: string): Promise<void> {
		try {
			if (this.editingSessionId === sessionId) {
				this.cancelRenameSession();
			}
			await this.microIDEAgentService.closeSession(sessionId);
			this.historyPopoverElement?.classList.remove('visible');
		} catch (error) {
			this.notificationService.error(toErrorMessage(error));
		} finally {
			this.renderState();
		}
	}

	private beginRenameSession(session: IMicroIDEAgentSessionTab, keepPopover?: 'history'): void {
		if (session.status === 'busy') {
			return;
		}
		this.editingSessionId = session.id;
		this.editingSessionSurface = keepPopover === 'history' ? 'history' : 'tabs';
		this.editingSessionValue = sessionDisplayTitle(session);
		this.closeOtherPopovers(keepPopover);
		this.renderState();
	}

	private cancelRenameSession(): void {
		if (!this.editingSessionId) {
			return;
		}
		this.editingSessionId = undefined;
		this.editingSessionSurface = 'tabs';
		this.editingSessionValue = '';
		this.renderState();
	}

	private async commitRenameSession(sessionId: string, value: string): Promise<void> {
		const title = value.trim();
		const editingSessionId = this.editingSessionId;
		this.editingSessionId = undefined;
		this.editingSessionSurface = 'tabs';
		this.editingSessionValue = '';
		if (!title) {
			this.renderState();
			return;
		}

		try {
			await this.microIDEAgentService.renameSession(sessionId, title);
		} catch (error) {
			this.notificationService.error(toErrorMessage(error));
		} finally {
			if (this.editingSessionId === editingSessionId) {
				this.editingSessionId = undefined;
				this.editingSessionValue = '';
			}
			this.renderState();
		}
	}

	private toggleHistoryPopover(): void {
		const popover = this.historyPopoverElement;
		if (!popover) {
			return;
		}

		const state = this.microIDEAgentService.getState();
		const visible = !popover.classList.contains('visible');
		if (visible) {
			this.closeOtherPopovers('history');
		}
		this.renderHistoryPopover(state, visible);
	}

	/** Closes every floating popover except the named one, so only one is open at a time. */
	private closeOtherPopovers(keep?: 'history' | 'agentMode' | 'permission' | 'model' | 'command' | 'mention' | 'skills' | 'connectors' | 'workspace' | 'taskFiles' | 'taskSidePanelMenu'): void {
		if (keep !== 'history') {
			this.historyPopoverElement?.classList.remove('visible');
		}
		if (keep !== 'agentMode') {
			this.agentModePopoverElement?.classList.remove('visible');
			this.agentModeButton?.setAttribute('aria-expanded', 'false');
		}
		if (keep !== 'permission') {
			this.permissionPopoverElement?.classList.remove('visible');
		}
		if (keep !== 'model') {
			this.modelPopoverElement?.classList.remove('visible');
		}
		if (keep !== 'command') {
			this.commandPaletteElement?.classList.remove('visible');
		}
		if (keep !== 'mention') {
			this.mentionPopoverElement?.classList.remove('visible');
		}
		if (keep !== 'skills') {
			this.skillsPopoverElement?.classList.remove('visible');
			this.skillsButton?.setAttribute('aria-expanded', 'false');
		}
		if (keep !== 'connectors') {
			this.connectorsPopoverElement?.classList.remove('visible');
			this.connectorsButton?.setAttribute('aria-expanded', 'false');
		}
		if (keep !== 'workspace') {
			this.workspacePopoverElement?.classList.remove('visible');
			this.workspaceButton?.setAttribute('aria-expanded', 'false');
		}
		if (keep !== 'taskFiles') {
			this.taskStudioFileSearchElement?.classList.remove('visible');
		}
		if (keep !== 'taskSidePanelMenu') {
			this.taskSidePanelElement?.querySelector('.microide-task-side-panel-menu')?.classList.remove('visible');
		}
	}

	private selectWorkbenchSurface(surface: MicroIDEWorkbenchSurface): void {
		this.activeWorkbenchSurface = surface;
		if (surface !== 'task') {
			this.hideTaskBrowserView();
		}
		this.closeOtherPopovers();
		this.renderState();
	}

	private showNewTaskStudio(): void {
		this.activeWorkbenchSurface = 'task';
		this.showingNewTaskStudio = true;
		this.taskSidePanelVisible = false;
		this.hideTaskBrowserView();
		this.closeOtherPopovers();
		this.renderState();
	}

	private openTaskSidePanel(mode: MicroIDETaskSidePanel): void {
		this.activeWorkbenchSurface = 'task';
		this.showingNewTaskStudio = false;
		this.taskSidePanelMode = mode;
		this.taskSidePanelVisible = true;
		this.closeOtherPopovers();
		this.renderState();
	}

	private toggleTaskSidePanel(mode?: MicroIDETaskSidePanel): void {
		if (mode) {
			if (this.taskSidePanelVisible && this.taskSidePanelMode === mode) {
				this.taskSidePanelVisible = false;
			} else {
				this.openTaskSidePanel(mode);
			}
			this.renderState();
			return;
		}
		this.taskSidePanelVisible = !this.taskSidePanelVisible;
		this.showingNewTaskStudio = false;
		this.closeOtherPopovers();
		this.renderState();
	}

	private hasTaskMessages(state: IMicroIDEAgentState): boolean {
		return state.messages.some(message => message.kind !== 'runReport');
	}

	private seedPrompt(prompt: string, options?: { readonly newTask?: boolean }): void {
		void this.launchPromptFromWorkbench(prompt, options);
	}

	private async launchPromptFromWorkbench(prompt: string, options?: { readonly newTask?: boolean }): Promise<void> {
		const trimmed = prompt.trim();
		if (!trimmed) {
			return;
		}
		const state = this.microIDEAgentService.getState();
		if (isTurnRunning(state)) {
			this.notificationService.info(localize('microide.workbuddy.taskAlreadyRunning', "A task is already running. Wait for it to finish before starting another."));
			return;
		}

		this.activeWorkbenchSurface = 'task';
		this.showingNewTaskStudio = false;
		this.closeOtherPopovers();
		this.setComposerEnabled(false);
		try {
			if (options?.newTask && this.hasTaskMessages(this.microIDEAgentService.getState())) {
				await this.microIDEAgentService.startNewSession();
			}
			await this.microIDEAgentService.sendPrompt(trimmed, [], this.getSendableFileContexts());
			this.pendingAttachments = [];
			this.pendingFileContexts = [];
		} catch (error) {
			this.notificationService.error(toErrorMessage(error));
		} finally {
			this.setComposerEnabled(true);
			this.renderState();
		}
	}

	private renderWorkBuddySidebar(container: HTMLElement, state: IMicroIDEAgentState): void {
		dom.reset(container);

		const brand = dom.append(container, dom.$('.microide-workbuddy-brand'));
		const mark = dom.append(brand, dom.$('.microide-workbuddy-brand-mark'));
		appendIcon(mark, Codicon.sparkle);
		const copy = dom.append(brand, dom.$('.microide-workbuddy-brand-copy'));
		const name = dom.append(copy, dom.$('.microide-workbuddy-brand-name'));
		name.textContent = localize('microide.workbuddy.MicroWorker', "MicroWorker");
		const meta = dom.append(copy, dom.$('.microide-workbuddy-brand-meta'));
		meta.textContent = localize('microide.workbuddy.agentWorkspace', "Coding Agent Workspace");

		const nav = dom.append(container, dom.$('.microide-workbuddy-nav'));
		for (const item of WORKBUDDY_NAV_ITEMS) {
			const button = dom.append(nav, dom.$('button.microide-workbuddy-nav-button')) as HTMLButtonElement;
			button.type = 'button';
			button.classList.toggle('active', item.id === this.activeWorkbenchSurface);
			button.title = item.label + ' - ' + item.description;
			appendIcon(button, item.icon);
			const body = dom.append(button, dom.$('.microide-workbuddy-nav-copy'));
			const label = dom.append(body, dom.$('.microide-workbuddy-nav-label'));
			label.textContent = item.label;
			const description = dom.append(body, dom.$('.microide-workbuddy-nav-description'));
			description.textContent = item.description;
			button.addEventListener('click', () => {
				if (item.id === 'task') {
					this.showNewTaskStudio();
				} else {
					this.selectWorkbenchSurface(item.id);
				}
			});
		}

		const taskHeader = dom.append(container, dom.$('.microide-workbuddy-sidebar-section'));
		const taskTitle = dom.append(taskHeader, dom.$('span'));
		taskTitle.textContent = localize('microide.workbuddy.tasks', "Tasks");
		const taskCount = dom.append(taskHeader, dom.$('span.microide-workbuddy-sidebar-count'));
		taskCount.textContent = String(state.sessions.filter(session => !session.closed).length);

		const tasks = dom.append(container, dom.$('.microide-workbuddy-task-list'));
		const openSessions = state.sessions.filter(session => !session.closed).slice().sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8);
		if (!openSessions.length) {
			const empty = dom.append(tasks, dom.$('.microide-workbuddy-task-empty'));
			appendIcon(empty, Codicon.add);
			const emptyText = dom.append(empty, dom.$('span'));
			emptyText.textContent = localize('microide.workbuddy.noTasks', "No tasks yet");
		}
		for (const session of openSessions) {
			const row = dom.append(tasks, dom.$('.microide-workbuddy-task-row')) as HTMLElement;
			row.classList.toggle('active', !this.showingNewTaskStudio && session.id === state.activeSessionId);
			row.classList.toggle('running', session.status === 'busy');
			row.classList.toggle('error', session.status === 'error');
			row.title = formatSessionTabTitle(session);

			const open = dom.append(row, dom.$('button.microide-workbuddy-task-open')) as HTMLButtonElement;
			open.type = 'button';
			open.title = formatSessionTabTitle(session);
			open.setAttribute('aria-label', localize('microide.workbuddy.openTaskTitle', "Open {0}", sessionDisplayTitle(session)));
			const body = dom.append(open, dom.$('.microide-workbuddy-task-copy'));
			const label = dom.append(body, dom.$('.microide-workbuddy-task-label'));
			label.textContent = sessionDisplayTitle(session);
			const detail = dom.append(body, dom.$('.microide-workbuddy-task-detail'));
			detail.textContent = session.status === 'busy'
				? localize('microide.workbuddy.taskRunning', "Running")
				: formatSessionTime(session.updatedAt);
			open.addEventListener('click', () => {
				this.activeWorkbenchSurface = 'task';
				this.showingNewTaskStudio = false;
				void this.switchSession(session.id);
			});

			const stateSlot = dom.append(row, dom.$('.microide-workbuddy-task-state'));
			if (session.status === 'busy') {
				stateSlot.title = localize('microide.workbuddy.taskRunning', "Running");
				appendIcon(stateSlot, Codicon.sync);
			} else if (session.status === 'error') {
				stateSlot.title = localize('microide.workbuddy.taskError', "Task has an error");
				appendIcon(stateSlot, Codicon.error);
			} else {
				stateSlot.textContent = formatSessionTime(session.updatedAt);
			}

			const remove = dom.append(row, dom.$('button.microide-workbuddy-task-delete')) as HTMLButtonElement;
			remove.type = 'button';
			remove.title = localize('microide.workbuddy.deleteTaskTitle', "Delete {0}", sessionDisplayTitle(session));
			remove.setAttribute('aria-label', remove.title);
			remove.disabled = session.status === 'busy';
			appendIcon(remove, Codicon.trash);
			remove.addEventListener('click', event => {
				event.preventDefault();
				event.stopPropagation();
				if (session.status === 'busy') {
					return;
				}
				void this.closeSession(session.id);
			});
		}

		const account = dom.append(container, dom.$('.microide-workbuddy-account'));
		appendIcon(account, state.auth.isAuthenticated ? Codicon.account : Codicon.lock);
		const accountCopy = dom.append(account, dom.$('.microide-workbuddy-account-copy'));
		const accountName = dom.append(accountCopy, dom.$('.microide-workbuddy-account-name'));
		accountName.textContent = state.auth.displayName ?? localize('microide.workbuddy.localUser', "Local");
		const accountMeta = dom.append(accountCopy, dom.$('.microide-workbuddy-account-meta'));
		accountMeta.textContent = state.engine ? state.engine : statusLabel(state.status);
	}

	private renderWorkBuddySurface(container: HTMLElement, state: IMicroIDEAgentState): void {
		dom.reset(container);
		container.className = 'microide-workbuddy-surface surface-' + this.activeWorkbenchSurface;
		const hasMessages = this.hasTaskMessages(state);
		const showingStudio = this.activeWorkbenchSurface === 'task' && this.showingNewTaskStudio;
		container.classList.toggle('has-task-progress', this.activeWorkbenchSurface === 'task' && hasMessages && !showingStudio);
		container.classList.toggle('new-task-studio', showingStudio);
		if (this.activeWorkbenchSurface === 'task') {
			if (hasMessages && !showingStudio) {
				this.renderTaskProgressSurface(container, state);
			} else {
				this.renderTaskLauncherSurface(container, state);
			}
			return;
		}
		if (this.activeWorkbenchSurface === 'plugins') {
			this.renderPluginsSurface(container, state);
			return;
		}
		if (this.activeWorkbenchSurface === 'automation') {
			this.renderCollectionSurface(
				container,
				localize('microide.workbuddy.automationSurfaceTitle', "Automation"),
				localize('microide.workbuddy.automationSurfaceDescription', "Turn repeatable engineering routines into prompts that can be scheduled or reused."),
				WORKBUDDY_AUTOMATION_CARDS
			);
			return;
		}
		this.showNewTaskStudio();
	}

	private renderTaskLauncherSurface(container: HTMLElement, state: IMicroIDEAgentState): void {
		const mode = this.taskCreationMode;
		const categories = mode === 'working' ? WORKBUDDY_WORKING_CATEGORIES : WORKBUDDY_CODING_CATEGORIES;
		const starters = mode === 'working' ? WORKBUDDY_AUTOMATION_CARDS : WORKBUDDY_PROMPT_STARTERS;
		const studio = dom.append(container, dom.$('.microide-workbuddy-studio'));
		let input: HTMLTextAreaElement | undefined;

		const title = dom.append(studio, dom.$('.microide-workbuddy-studio-title'));
		title.textContent = mode === 'working'
			? localize('microide.workbuddy.workplaceSuperpower', "MicroWorker Your Workplace Superpower")
			: localize('microide.workbuddy.developmentSuperpower', "MicroWorker Your Development Superpower");

		const modes = dom.append(studio, dom.$('.microide-workbuddy-mode-row.studio-modes'));
		for (const option of [
			{ id: 'working' as const, label: localize('microide.workbuddy.modeWorking', "Working") },
			{ id: 'coding' as const, label: localize('microide.workbuddy.modeCoding', "Coding") }
		]) {
			const button = dom.append(modes, dom.$('button.microide-workbuddy-mode-pill')) as HTMLButtonElement;
			button.type = 'button';
			button.classList.toggle('active', option.id === mode);
			button.textContent = option.label;
			button.addEventListener('click', () => {
				this.taskCreationMode = option.id;
				this.renderState();
			});
		}

		const categoryRow = dom.append(studio, dom.$('.microide-workbuddy-category-row'));
		for (const category of categories) {
			const chip = dom.append(categoryRow, dom.$('button.microide-workbuddy-category-chip')) as HTMLButtonElement;
			chip.type = 'button';
			chip.textContent = category.label;
			chip.addEventListener('click', () => {
				if (!input) {
					return;
				}
				input.value = category.prompt;
				input.focus();
				input.setSelectionRange(input.value.length, input.value.length);
			});
		}

		const starterGrid = dom.append(studio, dom.$('.microide-workbuddy-card-grid.starters'));
		for (const card of starters) {
			this.appendWorkbenchCard(starterGrid, card, { newTask: true });
		}

		const composer = dom.append(studio, dom.$('.microide-workbuddy-studio-composer'));
		input = dom.append(composer, dom.$('textarea.microide-workbuddy-studio-input')) as HTMLTextAreaElement;
		this.inputElement = input;
		this.contextMeterElement = undefined;
		this.commandPaletteElement = undefined;
		this.mentionPopoverElement = undefined;
		this.turnButton = undefined;
		this.permissionModeButton = undefined;
		this.permissionPopoverElement = undefined;
		this.workspaceButton = undefined;
		this.workspacePopoverElement = undefined;
		this.connectorsButton = undefined;
		this.connectorsPopoverElement = undefined;
		input.rows = 3;
		input.placeholder = localize('microide.workbuddy.studioPlaceholder', "What can I help you with today? @ to reference files, / for slash commands");
		input.disabled = state.status === 'busy' || state.status === 'error';
		input.addEventListener('keydown', event => {
			if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
				event.preventDefault();
				void this.launchPromptFromWorkbench(input.value, { newTask: true });
			}
		});

		const contextRow = dom.append(composer, dom.$('.microide-workbuddy-studio-contexts'));
		this.taskStudioFileContextsElement = contextRow;
		this.renderStudioFileContexts(contextRow);

		const fileSearch = dom.append(composer, dom.$('.microide-workbuddy-file-search'));
		this.taskStudioFileSearchElement = fileSearch;
		fileSearch.addEventListener('mousedown', event => event.stopPropagation());

		const toolbar = dom.append(composer, dom.$('.microide-workbuddy-studio-toolbar'));
		const toolGroup = dom.append(toolbar, dom.$('.microide-workbuddy-studio-tools'));
		const studioAgentAnchor = dom.append(toolGroup, dom.$('.microide-popover-anchor'));
		this.agentModeButton = dom.append(studioAgentAnchor, dom.$('button.microide-agent-mode-button')) as HTMLButtonElement;
		this.agentModeButton.type = 'button';
		this.agentModeButton.title = localize('microide.agentMode', "Agent mode");
		this.renderAgentModeButton(state);
		this.agentModePopoverElement = dom.append(studioAgentAnchor, dom.$('.microide-agent-mode-popover'));
		this.agentModeButton.disabled = state.status === 'busy' || state.status === 'error';
		this.agentModeButton.addEventListener('click', () => this.toggleAgentModePopover());

		const studioSkillsAnchor = dom.append(toolGroup, dom.$('.microide-popover-anchor'));
		this.skillsButton = this.appendComposerChip(
			studioSkillsAnchor,
			Codicon.extensions,
			localize('microide.workbuddy.skills', "Skills"),
			undefined,
			localize('microide.workbuddy.skillsTitle', "Search and use installed skills"),
			state.status === 'error',
			() => this.toggleSkillsPopover(this.microIDEAgentService.getState())
		);
		this.skillsButton.setAttribute('aria-haspopup', 'true');
		this.skillsPopoverElement = dom.append(studioSkillsAnchor, dom.$('.microide-workbuddy-popover.skills'));

		this.appendStudioToolChip(toolGroup, permissionModeIcon(state.permissionMode), permissionModeShortLabel(state.permissionMode), () => void this.selectPermissionMode(state.permissionMode === 'auto' ? 'ask' : 'auto'), state.status === 'error');

		const studioModelAnchor = dom.append(toolGroup, dom.$('.microide-popover-anchor'));
		this.modelButton = dom.append(studioModelAnchor, dom.$('button.microide-model-button')) as HTMLButtonElement;
		this.modelButton.type = 'button';
		this.modelButton.title = localize('microide.modelPicker', "microClaude model");
		this.modelPopoverElement = dom.append(studioModelAnchor, dom.$('.microide-model-popover'));
		this.renderModelButton(state);
		this.modelButton.disabled = state.status === 'busy' || state.status === 'error';
		this.modelButton.addEventListener('click', () => this.toggleModelPopover(this.microIDEAgentService.getState()));

		const actions = dom.append(toolbar, dom.$('.microide-workbuddy-studio-actions'));
		this.appendStudioIconButton(actions, Codicon.add, localize('microide.workbuddy.addContext', "Add context"), () => this.openStudioFileSearch(input), state.status === 'busy' || state.status === 'error');
		let improveButton: HTMLButtonElement | undefined;
		improveButton = this.appendStudioIconButton(actions, Codicon.sparkle, localize('microide.workbuddy.improvePrompt', "Improve prompt"), () => void this.improvePromptInput(input, mode, improveButton), this.improvingPrompt || state.status === 'busy' || state.status === 'error');
		improveButton.classList.toggle('running', this.improvingPrompt);
		this.appendStudioIconButton(actions, Codicon.send, localize('microide.workbuddy.startTask', "Start task"), () => void this.launchPromptFromWorkbench(input.value, { newTask: true }), state.status === 'busy' || state.status === 'error');

		const workspaceRow = dom.append(composer, dom.$('.microide-workbuddy-studio-workspace'));
		appendIcon(workspaceRow, Codicon.folder);
		const workspaceText = dom.append(workspaceRow, dom.$('span'));
		workspaceText.textContent = state.session?.workspace || this.workspaceContextService.getWorkspace().folders[0]?.uri.fsPath || localize('microide.workbuddy.selectWorkspace', "Select workspace");
	}

	private renderStudioFileContexts(container: HTMLElement): void {
		dom.reset(container);
		const contexts = this.getVisibleFileContexts();
		container.classList.toggle('visible', contexts.length > 0);

		for (const context of contexts) {
			const chip = dom.append(container, dom.$(context.source === 'activeEditor'
				? 'button.microide-workbuddy-studio-context-chip.active-editor'
				: '.microide-workbuddy-studio-context-chip')) as HTMLElement;
			chip.title = context.path;
			chip.classList.toggle('disabled', !context.enabled);
			appendIcon(chip, context.source === 'activeEditor' ? context.enabled ? Codicon.file : Codicon.eyeClosed : Codicon.file);
			const label = dom.append(chip, dom.$('span'));
			label.textContent = context.source === 'activeEditor' ? context.label : context.path;
			if (chip instanceof HTMLButtonElement) {
				chip.type = 'button';
				chip.setAttribute('aria-pressed', String(context.enabled));
				chip.addEventListener('click', () => {
					this.toggleActiveEditorContext();
					this.renderStudioFileContexts(container);
				});
			} else {
				const remove = dom.append(chip, dom.$('button.microide-workbuddy-studio-context-remove')) as HTMLButtonElement;
				remove.type = 'button';
				remove.title = localize('microide.removeFileContext', "Remove file context");
				appendIcon(remove, Codicon.close);
				remove.addEventListener('click', event => {
					event.stopPropagation();
					this.removeFileContext(context.id);
					this.renderStudioFileContexts(container);
				});
			}
		}
	}

	private openStudioFileSearch(input: HTMLTextAreaElement): void {
		const container = this.taskStudioFileSearchElement;
		if (!container) {
			return;
		}
		this.closeOtherPopovers('taskFiles');
		container.classList.add('visible');
		this.renderStudioFileSearch(container, '', input);
	}

	private renderStudioFileSearch(container: HTMLElement, initialQuery: string, promptInput: HTMLTextAreaElement): void {
		dom.reset(container);
		const box = dom.append(container, dom.$('.microide-workbuddy-file-search-box'));
		const searchInput = dom.append(box, dom.$('input.microide-workbuddy-file-search-input')) as HTMLInputElement;
		searchInput.type = 'text';
		searchInput.value = initialQuery;
		searchInput.placeholder = localize('microide.workbuddy.fileSearchPlaceholder', "Search project files");
		const results = dom.append(box, dom.$('.microide-workbuddy-file-search-results'));

		const updateResults = () => void this.updateStudioFileSearchResults(results, searchInput.value, promptInput, searchInput);
		searchInput.addEventListener('input', updateResults);
		searchInput.addEventListener('keydown', event => {
			if (event.key === 'Escape') {
				event.preventDefault();
				container.classList.remove('visible');
				promptInput.focus();
				return;
			}
			if (event.key === 'Enter') {
				const first = results.querySelector<HTMLButtonElement>('button.microide-workbuddy-file-search-result');
				if (first) {
					event.preventDefault();
					first.click();
				}
			}
		});
		updateResults();
		searchInput.focus();
	}

	private async updateStudioFileSearchResults(results: HTMLElement, query: string, promptInput: HTMLTextAreaElement, searchInput: HTMLInputElement): Promise<void> {
		this.taskStudioFileSearchCts?.cancel();
		const cts = new CancellationTokenSource();
		this.taskStudioFileSearchCts = cts;
		dom.reset(results);
		const loading = dom.append(results, dom.$('.microide-workbuddy-file-search-empty'));
		loading.textContent = localize('microide.workbuddy.fileSearchLoading', "Searching...");

		try {
			const suggestions = await this.getMentionSuggestions(query.trim(), cts);
			if (cts.token.isCancellationRequested || this.taskStudioFileSearchCts !== cts) {
				return;
			}
			dom.reset(results);
			if (!suggestions.length) {
				const empty = dom.append(results, dom.$('.microide-workbuddy-file-search-empty'));
				empty.textContent = localize('microide.workbuddy.fileSearchEmpty', "No matching files");
				return;
			}
			for (const suggestion of suggestions) {
				this.appendStudioFileSuggestion(results, suggestion, promptInput, searchInput);
			}
		} catch {
			if (cts.token.isCancellationRequested || this.taskStudioFileSearchCts !== cts) {
				return;
			}
			dom.reset(results);
			const empty = dom.append(results, dom.$('.microide-workbuddy-file-search-empty'));
			empty.textContent = localize('microide.workbuddy.fileSearchFailed', "File search is unavailable");
		}
	}

	private appendStudioFileSuggestion(results: HTMLElement, suggestion: IMicroIDEMentionSuggestion, promptInput: HTMLTextAreaElement, searchInput: HTMLInputElement): void {
		const row = dom.append(results, dom.$(`button.microide-workbuddy-file-search-result.${suggestion.isDirectory ? 'directory' : 'file'}`)) as HTMLButtonElement;
		row.type = 'button';
		row.title = suggestion.path;
		appendIcon(row, suggestion.isDirectory ? Codicon.folder : Codicon.file);
		const copy = dom.append(row, dom.$('.microide-workbuddy-file-search-copy'));
		const label = dom.append(copy, dom.$('span.microide-workbuddy-file-search-name'));
		label.textContent = fileSearchDisplayName(suggestion.path, suggestion.isDirectory);
		const parent = dom.append(copy, dom.$('span.microide-workbuddy-file-search-path'));
		parent.textContent = fileSearchParentPath(suggestion.path);
		row.addEventListener('click', () => {
			if (suggestion.isDirectory) {
				searchInput.value = ensureTrailingSlash(suggestion.path);
				searchInput.focus();
				void this.updateStudioFileSearchResults(results, searchInput.value, promptInput, searchInput);
				return;
			}
			this.addFileContext(suggestion.path, 'mention');
			if (this.taskStudioFileContextsElement) {
				this.renderStudioFileContexts(this.taskStudioFileContextsElement);
			}
			this.taskStudioFileSearchElement?.classList.remove('visible');
			promptInput.focus();
		});
	}

	private renderTaskProgressSurface(container: HTMLElement, state: IMicroIDEAgentState): void {
		const strip = dom.append(container, dom.$('.microide-workbuddy-progress-strip'));
		const active = state.sessions.find(session => session.id === state.activeSessionId);
		const copy = dom.append(strip, dom.$('.microide-workbuddy-progress-copy'));
		const title = dom.append(copy, dom.$('.microide-workbuddy-progress-title'));
		title.textContent = active ? sessionDisplayTitle(active) : localize('microide.workbuddy.currentTask', "Current task");
		const subtitle = dom.append(copy, dom.$('.microide-workbuddy-progress-subtitle'));
		subtitle.textContent = state.turnStatus ? formatTurnStatusDetail(state.turnStatus) : state.status === 'ready' ? localize('microide.workbuddy.completedOrReady', "Ready for a follow-up") : statusLabel(state.status);

		const actions = dom.append(strip, dom.$('.microide-workbuddy-progress-actions'));
		this.renderWorkBuddyTaskStatus(actions, state);
		const sidePanelButton = appendIconButton(actions, this.taskSidePanelVisible ? Codicon.layoutSidebarRightOff : Codicon.layoutSidebarRight, localize('microide.workbuddy.toggleTaskSidePanel', "Open task panel"), 'compact secondary icon-only task-side-toggle');
		sidePanelButton.setAttribute('aria-pressed', String(this.taskSidePanelVisible));
		sidePanelButton.addEventListener('click', event => {
			event.stopPropagation();
			this.toggleTaskSidePanel();
		});
	}

	private renderWorkBuddyTaskStatus(container: HTMLElement, state: IMicroIDEAgentState): void {
		const presentation = getWorkBuddyTaskStatusPresentation(state);
		const pill = dom.append(container, dom.$('.microide-workbuddy-task-status'));
		pill.classList.add('state-' + presentation.state);
		pill.setAttribute('role', 'status');
		pill.setAttribute('aria-live', 'polite');
		appendIcon(pill, presentation.icon);
		const label = dom.append(pill, dom.$('span'));
		label.textContent = presentation.label;
	}

	private renderPluginsSurface(container: HTMLElement, state: IMicroIDEAgentState): void {
		const shell = dom.append(container, dom.$('.microide-workbuddy-marketplace'));

		const header = dom.append(shell, dom.$('.microide-workbuddy-marketplace-header'));
		const title = dom.append(header, dom.$('.microide-workbuddy-marketplace-title'));
		title.textContent = localize('microide.workbuddy.skillsSurfaceTitle', "Skills");
		const subtitle = dom.append(header, dom.$('.microide-workbuddy-marketplace-subtitle'));
		subtitle.textContent = localize('microide.workbuddy.skillsSurfaceDescription', "Browse installed skills and lightweight plugin-backed skill packs for MicroWorker.");
		const search = dom.append(header, dom.$('.microide-workbuddy-marketplace-search'));
		appendIcon(search, Codicon.search);
		const input = dom.append(search, dom.$('input')) as HTMLInputElement;
		input.type = 'search';
		input.placeholder = localize('microide.workbuddy.searchSkills', "Search skills");

		const installedPlugins = state.plugins.installed;
		const installedIds = new Set(installedPlugins.map(plugin => plugin.id.toLowerCase()));
		const availablePlugins = [...state.plugins.available, ...WORKBUDDY_FALLBACK_INSTALLABLE_PLUGINS]
			.filter((plugin, index, source) => source.findIndex(candidate => candidate.id.toLowerCase() === plugin.id.toLowerCase()) === index)
			.filter(plugin => !installedIds.has(plugin.id.toLowerCase()));
		const rows: HTMLElement[] = [];
		this.renderMarketplaceSection(shell, localize('microide.workbuddy.installedSkillsAndPlugins', "Installed"), installedPlugins, localize('microide.workbuddy.noInstalledPlugins', "No installed skills found."), rows);
		this.renderSkillShelf(shell, state.skills, rows);
		this.renderMarketplaceSection(shell, localize('microide.workbuddy.availableSkillsAndPlugins', "Available"), availablePlugins, localize('microide.workbuddy.noAvailablePlugins', "No installable skills found."), rows);

		input.addEventListener('input', () => {
			const query = input.value.trim().toLowerCase();
			for (const row of rows) {
				const haystack = row.getAttribute('data-search') ?? '';
				row.classList.toggle('hidden', Boolean(query) && !haystack.includes(query));
			}
		});
	}
	private renderMarketplaceSection(container: HTMLElement, titleText: string, plugins: readonly IMicroClaudePluginInfo[], emptyText: string, rows: HTMLElement[]): void {
		const section = dom.append(container, dom.$('.microide-workbuddy-marketplace-section'));
		const heading = dom.append(section, dom.$('.microide-workbuddy-marketplace-section-title'));
		heading.textContent = titleText;
		if (!plugins.length) {
			const empty = dom.append(section, dom.$('.microide-workbuddy-marketplace-empty'));
			empty.textContent = emptyText;
			return;
		}
		const list = dom.append(section, dom.$('.microide-workbuddy-marketplace-list'));
		for (const plugin of plugins) {
			rows.push(this.appendPluginCatalogItem(list, plugin));
		}
	}

	private renderSkillShelf(container: HTMLElement, skills: readonly IMicroClaudeSkillInfo[], rows: HTMLElement[]): void {
		const section = dom.append(container, dom.$('.microide-workbuddy-marketplace-section.skills'));
		const heading = dom.append(section, dom.$('.microide-workbuddy-marketplace-section-title'));
		heading.textContent = localize('microide.workbuddy.installedSkills', "Installed skills");
		if (!skills.length) {
			const empty = dom.append(section, dom.$('.microide-workbuddy-marketplace-empty'));
			empty.textContent = localize('microide.workbuddy.noInstalledSkills', "No installed skills found.");
			return;
		}
		const list = dom.append(section, dom.$('.microide-workbuddy-marketplace-list'));
		for (const skill of skills.slice(0, 8)) {
			const pluginLike: IMicroClaudePluginInfo = {
				id: skill.id,
				name: skill.name,
				description: skill.description,
				marketplace: skill.source,
				path: skill.path,
				status: 'installed',
				actionCommand: '/' + skill.name.replace(/^\//, '')
			};
			rows.push(this.appendPluginCatalogItem(list, pluginLike, true));
		}
	}

	private appendPluginCatalogItem(container: HTMLElement, plugin: IMicroClaudePluginInfo, skill = false): HTMLElement {
		const row = dom.append(container, dom.$('.microide-workbuddy-marketplace-item')) as HTMLElement;
		row.setAttribute('data-search', [plugin.name, plugin.description, plugin.marketplace, plugin.source].join(' ').toLowerCase());
		const icon = dom.append(row, dom.$('.microide-workbuddy-marketplace-icon'));
		appendIcon(icon, skill ? Codicon.sparkle : plugin.status === 'installed' ? Codicon.extensions : Codicon.cloud);
		const copy = dom.append(row, dom.$('.microide-workbuddy-marketplace-copy'));
		const title = dom.append(copy, dom.$('.microide-workbuddy-marketplace-item-title'));
		title.textContent = plugin.name;
		const description = dom.append(copy, dom.$('.microide-workbuddy-marketplace-item-description'));
		description.textContent = plugin.description;
		const meta = dom.append(copy, dom.$('.microide-workbuddy-marketplace-item-meta'));
		meta.textContent = plugin.marketplace || plugin.source || (plugin.status === 'installed' ? localize('microide.workbuddy.installed', "Installed") : localize('microide.workbuddy.available', "Available"));
		const actions = dom.append(row, dom.$('.microide-workbuddy-marketplace-actions'));
		const installed = plugin.status === 'installed';
		const installing = this.installingPluginIds.has(plugin.id);
		const uninstalling = this.uninstallingPluginIds.has(plugin.id);
		const action = dom.append(actions, dom.$('button.microide-workbuddy-marketplace-action')) as HTMLButtonElement;
		action.type = 'button';
		action.textContent = installing
			? localize('microide.workbuddy.installing', "Installing...")
			: installed ? localize('microide.workbuddy.tryInChat', "Try in chat") : localize('microide.workbuddy.install', "Install");
		action.disabled = installing || uninstalling;
		action.title = installed
			? localize('microide.workbuddy.tryInstalledPlugin', "Start a chat with this installed plugin")
			: localize('microide.workbuddy.installPluginNow', "Install this plugin through the backend plugin catalog");
		action.addEventListener('click', event => {
			event.preventDefault();
			event.stopPropagation();
			if (installed) {
				this.seedPrompt(plugin.actionCommand || ('Use ' + plugin.name + ' for this task.'), { newTask: true });
				return;
			}
			void this.installCatalogPlugin(plugin);
		});
		if (installed && !skill) {
			const uninstall = dom.append(actions, dom.$('button.microide-workbuddy-marketplace-action.subtle')) as HTMLButtonElement;
			uninstall.type = 'button';
			uninstall.disabled = installing || uninstalling;
			uninstall.textContent = uninstalling ? localize('microide.workbuddy.uninstalling', "Removing...") : localize('microide.workbuddy.uninstall', "Uninstall");
			uninstall.title = localize('microide.workbuddy.uninstallPlugin', "Uninstall this plugin");
			uninstall.addEventListener('click', event => {
				event.preventDefault();
				event.stopPropagation();
				void this.uninstallCatalogPlugin(plugin);
			});
		}
		return row;
	}
	private async installCatalogPlugin(plugin: IMicroClaudePluginInfo): Promise<void> {
		if (this.installingPluginIds.has(plugin.id)) {
			return;
		}
		this.installingPluginIds.add(plugin.id);
		this.renderState();
		try {
			await this.microIDEAgentService.installPlugin(plugin.id);
			this.notificationService.info(localize('microide.workbuddy.pluginInstalled', "Installed {0}.", plugin.name));
		} catch (error) {
			this.notificationService.error(toErrorMessage(error));
		} finally {
			this.installingPluginIds.delete(plugin.id);
			this.renderState();
		}
	}

	private async uninstallCatalogPlugin(plugin: IMicroClaudePluginInfo): Promise<void> {
		if (this.uninstallingPluginIds.has(plugin.id)) {
			return;
		}
		this.uninstallingPluginIds.add(plugin.id);
		this.renderState();
		try {
			await this.microIDEAgentService.uninstallPlugin(plugin.id);
			this.notificationService.info(localize('microide.workbuddy.pluginUninstalled', "Uninstalled {0}.", plugin.name));
		} catch (error) {
			this.notificationService.error(toErrorMessage(error));
		} finally {
			this.uninstallingPluginIds.delete(plugin.id);
			this.renderState();
		}
	}

	private renderCollectionSurface(container: HTMLElement, titleText: string, subtitleText: string, cards: readonly IMicroIDEWorkbenchCard[]): void {
		const header = dom.append(container, dom.$('.microide-workbuddy-collection-header'));
		const title = dom.append(header, dom.$('.microide-workbuddy-collection-title'));
		title.textContent = titleText;
		const subtitle = dom.append(header, dom.$('.microide-workbuddy-collection-subtitle'));
		subtitle.textContent = subtitleText;
		const grid = dom.append(container, dom.$('.microide-workbuddy-card-grid'));
		for (const card of cards) {
			this.appendWorkbenchCard(grid, card);
		}
	}

	private appendWorkbenchCard(container: HTMLElement, card: IMicroIDEWorkbenchCard, options?: { readonly newTask?: boolean }): void {
		const button = dom.append(container, dom.$('button.microide-workbuddy-card')) as HTMLButtonElement;
		button.type = 'button';
		button.title = card.title + ' - ' + card.description;
		appendIcon(button, card.icon);
		const copy = dom.append(button, dom.$('.microide-workbuddy-card-copy'));
		const title = dom.append(copy, dom.$('.microide-workbuddy-card-title'));
		title.textContent = card.title;
		const description = dom.append(copy, dom.$('.microide-workbuddy-card-description'));
		description.textContent = card.description;
		const meta = dom.append(button, dom.$('.microide-workbuddy-card-meta'));
		meta.textContent = card.meta;
		if (card.actionLabel) {
			button.classList.add('has-action');
			const action = dom.append(button, dom.$('.microide-workbuddy-card-action'));
			action.textContent = card.actionLabel;
		}
		button.addEventListener('click', () => this.seedPrompt(card.prompt ?? card.title, options));
	}

	private appendStudioToolChip(container: HTMLElement, icon: ThemeIcon, label: string, action: () => void, disabled: boolean): HTMLButtonElement {
		const button = dom.append(container, dom.$('button.microide-workbuddy-tool-chip')) as HTMLButtonElement;
		button.type = 'button';
		button.disabled = disabled;
		button.title = label;
		appendIcon(button, icon);
		const text = dom.append(button, dom.$('span'));
		text.textContent = label;
		button.addEventListener('click', action);
		return button;
	}

	private appendStudioIconButton(container: HTMLElement, icon: ThemeIcon, label: string, action: () => void | Promise<void>, disabled: boolean): HTMLButtonElement {
		const button = dom.append(container, dom.$('button.microide-workbuddy-studio-icon-button')) as HTMLButtonElement;
		button.type = 'button';
		button.disabled = disabled;
		button.title = label;
		appendIcon(button, icon);
		button.addEventListener('click', action);
		return button;
	}

	private appendComposerChip(container: HTMLElement, icon: ThemeIcon, labelText: string, detailText: string | undefined, titleText: string, disabled: boolean, onClick: () => void, extraClass?: string): HTMLButtonElement {
		const button = dom.append(container, dom.$('button.microide-workbuddy-chip')) as HTMLButtonElement;
		button.type = 'button';
		button.title = titleText;
		button.disabled = disabled;
		if (extraClass) {
			button.classList.add(extraClass);
		}
		appendIcon(button, icon);
		const label = dom.append(button, dom.$('span.microide-workbuddy-chip-label'));
		label.textContent = labelText;
		if (detailText) {
			const detail = dom.append(button, dom.$('span.microide-workbuddy-chip-detail'));
			detail.textContent = detailText;
		}
		button.addEventListener('click', event => {
			event.preventDefault();
			event.stopPropagation();
			onClick();
		});
		return button;
	}

	private toggleSkillsPopover(state: IMicroIDEAgentState): void {
		const popover = this.skillsPopoverElement;
		if (!popover) {
			return;
		}
		const visible = !popover.classList.contains('visible');
		if (visible) {
			this.closeOtherPopovers('skills');
		}
		this.renderSkillsPopover(state, visible);
	}

	private renderSkillsPopover(state: IMicroIDEAgentState, visible: boolean): void {
		const popover = this.skillsPopoverElement;
		if (!popover) {
			return;
		}
		dom.reset(popover);
		popover.classList.toggle('visible', visible);
		this.skillsButton?.setAttribute('aria-expanded', String(visible));
		if (!visible) {
			return;
		}
		this.appendPopoverHeader(popover, localize('microide.workbuddy.skillsPopover', "Skills"), localize('microide.workbuddy.skillsPopoverDescription', "Installed skills returned by the backend skills catalog."));
		if (!state.skills.length) {
			const empty = dom.append(popover, dom.$('.microide-workbuddy-popover-empty'));
			empty.textContent = localize('microide.workbuddy.noInstalledSkills', "No installed skills found.");
			return;
		}
		const search = dom.append(popover, dom.$('.microide-workbuddy-popover-search'));
		appendIcon(search, Codicon.search);
		const input = dom.append(search, dom.$('input')) as HTMLInputElement;
		input.type = 'search';
		input.placeholder = localize('microide.workbuddy.searchInstalledSkills', "Search installed skills");
		const section = dom.append(popover, dom.$('.microide-workbuddy-popover-section'));
		section.textContent = localize('microide.workbuddy.installedSkills', "Installed skills");
		const list = dom.append(popover, dom.$('.microide-workbuddy-popover-list'));
		const rows: HTMLElement[] = [];
		for (const skill of state.skills) {
			const commandText = '/' + skill.name.replace(/^\//, '');
			const row = this.appendPopoverRow(list, Codicon.sparkle, commandText, skill.description || skill.name, skill.source || localize('microide.workbuddy.installed', "Installed"));
			row.setAttribute('data-search', [commandText, skill.description, skill.source, skill.origin].join(' ').toLowerCase());
			row.addEventListener('click', () => {
				this.skillsPopoverElement?.classList.remove('visible');
				this.acceptCommandSuggestion(commandText);
			});
			rows.push(row);
		}
		const empty = dom.append(popover, dom.$('.microide-workbuddy-popover-empty.hidden'));
		empty.textContent = localize('microide.workbuddy.noSkillMatches', "No matching skills");
		input.addEventListener('input', () => {
			const query = input.value.trim().toLowerCase();
			let visibleRows = 0;
			for (const row of rows) {
				const hidden = Boolean(query) && !(row.getAttribute('data-search') ?? '').includes(query);
				row.classList.toggle('hidden', hidden);
				if (!hidden) {
					visibleRows++;
				}
			}
			empty.classList.toggle('hidden', visibleRows > 0);
		});
		input.focus();
	}
	private toggleWorkspacePopover(state: IMicroIDEAgentState): void {
		const popover = this.workspacePopoverElement;
		if (!popover) {
			return;
		}
		const visible = !popover.classList.contains('visible');
		if (visible) {
			this.closeOtherPopovers('workspace');
		}
		this.renderWorkspacePopover(state, visible);
	}

	private renderWorkspacePopover(state: IMicroIDEAgentState, visible: boolean): void {
		const popover = this.workspacePopoverElement;
		if (!popover) {
			return;
		}
		dom.reset(popover);
		popover.classList.toggle('visible', visible);
		this.workspaceButton?.setAttribute('aria-expanded', String(visible));
		if (!visible) {
			return;
		}
		this.appendPopoverHeader(popover, localize('microide.workbuddy.workspace', "Workspace"), localize('microide.workbuddy.workspaceDescription', "Choose what the next task should treat as local context."));
		const folders = this.workspaceContextService.getWorkspace().folders;
		if (!folders.length) {
			const empty = dom.append(popover, dom.$('.microide-workbuddy-popover-empty'));
			empty.textContent = localize('microide.workbuddy.noWorkspace', "No workspace folder is open.");
			return;
		}
		for (const folder of folders) {
			const row = this.appendPopoverRow(popover, Codicon.folder, folder.name, folder.uri.fsPath || folder.uri.path, state.session?.workspace === folder.uri.fsPath ? localize('microide.workbuddy.selected', "Selected") : localize('microide.workbuddy.available', "Available"));
			row.addEventListener('click', () => this.seedPrompt('Use workspace ' + folder.name + ' as the primary context for this task.'));
		}
	}

	private appendPopoverHeader(container: HTMLElement, titleText: string, descriptionText: string): void {
		const header = dom.append(container, dom.$('.microide-workbuddy-popover-header'));
		const title = dom.append(header, dom.$('.microide-workbuddy-popover-title'));
		title.textContent = titleText;
		const description = dom.append(header, dom.$('.microide-workbuddy-popover-description'));
		description.textContent = descriptionText;
	}

	private appendPopoverRow(container: HTMLElement, icon: ThemeIcon, titleText: string, descriptionText: string, metaText: string): HTMLButtonElement {
		const row = dom.append(container, dom.$('button.microide-workbuddy-popover-row')) as HTMLButtonElement;
		row.type = 'button';
		row.title = titleText + ' - ' + descriptionText;
		appendIcon(row, icon);
		const body = dom.append(row, dom.$('.microide-workbuddy-popover-row-body'));
		const title = dom.append(body, dom.$('.microide-workbuddy-popover-row-title'));
		title.textContent = titleText;
		const description = dom.append(body, dom.$('.microide-workbuddy-popover-row-description'));
		description.textContent = descriptionText;
		const meta = dom.append(row, dom.$('.microide-workbuddy-popover-row-meta'));
		meta.textContent = metaText;
		return row;
	}

	private setComposerEnabled(enabled: boolean): void {
		if (this.inputElement) {
			this.inputElement.disabled = !enabled;
		}
		if (this.turnButton) {
			this.turnButton.disabled = !enabled;
		}
	}

	private renderState(): void {
		if (!this.root || !this.statusElement || !this.engineElement || !this.transcriptElement || !this.teamElement || !this.composerElement || !this.tabsElement || !this.historyPopoverElement || !this.sideNavElement || !this.surfaceElement || !this.taskSidePanelElement) {
			return;
		}

		const state = this.microIDEAgentService.getState();
		const hasMessages = this.hasTaskMessages(state);
		const showingStudio = this.activeWorkbenchSurface === 'task' && this.showingNewTaskStudio;
		const taskSidePanelHostVisible = this.activeWorkbenchSurface === 'task' && !showingStudio;
		this.root.classList.toggle('microide-new-task-studio', showingStudio);
		this.root.classList.toggle('microide-task-detail', this.activeWorkbenchSurface === 'task' && hasMessages && !showingStudio);
		this.root.classList.toggle('microide-task-side-panel-open', taskSidePanelHostVisible && this.taskSidePanelVisible);
		this.root.classList.toggle('microide-collection-surface', this.activeWorkbenchSurface !== 'task');
		this.renderSessionTabs(this.tabsElement, state);
		this.renderHistoryPopover(state, this.historyPopoverElement.classList.contains('visible'));
		renderStatus(this.statusElement, state);
		this.renderWorkBuddySidebar(this.sideNavElement, state);
		if (this.newSessionButton) {
			this.newSessionButton.disabled = state.status === 'busy' || state.status === 'error';
		}
		if (this.historyButton) {
			this.historyButton.disabled = state.sessions.length === 0;
		}

		this.renderEngine(this.engineElement, state);
		this.renderWorkBuddySurface(this.surfaceElement, state);
		this.renderTaskSidePanel(this.taskSidePanelElement, state, taskSidePanelHostVisible);
		const transcript = this.transcriptElement;
		const stickToBottom = transcript.scrollTop + transcript.clientHeight >= transcript.scrollHeight - 24;
		this.transcriptRenderer?.render(state);
		this.renderTeamStrip(this.teamElement, state);
		if (showingStudio || this.activeWorkbenchSurface !== 'task') {
			dom.reset(this.composerElement);
		} else {
			this.renderComposer(this.composerElement, state);
		}
		this.renderPermissionPrompt(state);

		if (stickToBottom) {
			transcript.scrollTop = transcript.scrollHeight;
		}
	}


	private renderTaskSidePanel(container: HTMLElement, state: IMicroIDEAgentState, hostVisible: boolean): void {
		const visible = hostVisible && this.taskSidePanelVisible;
		const showingBrowser = visible && this.taskSidePanelMode === 'browser';
		if (!showingBrowser) {
			this.hideTaskBrowserView();
		}
		this.taskSidePanelDisposables.clear();
		dom.reset(container);
		container.classList.toggle('hidden', !visible);
		container.classList.toggle('mode-browser', showingBrowser);
		container.classList.toggle('mode-changes', visible && this.taskSidePanelMode === 'changes');
		if (!visible) {
			return;
		}

		const toolbar = dom.append(container, dom.$('.microide-task-side-panel-toolbar'));
		const menuButton = appendIconButton(toolbar, this.taskSidePanelMode === 'browser' ? Codicon.browser : Codicon.diffMultiple, this.taskSidePanelMode === 'browser' ? localize('microide.workbuddy.browser', "Browser") : localize('microide.workbuddy.changes', "Changes"), 'compact secondary task-side-menu-button');
		appendIcon(menuButton, Codicon.chevronDown);
		menuButton.setAttribute('aria-haspopup', 'menu');
		menuButton.setAttribute('aria-expanded', 'false');
		const menu = dom.append(toolbar, dom.$('.microide-task-side-panel-menu'));
		this.appendTaskSidePanelMenuItem(menu, 'browser', Codicon.browser, localize('microide.workbuddy.browser', "Browser"));
		this.appendTaskSidePanelMenuItem(menu, 'changes', Codicon.diffMultiple, localize('microide.workbuddy.changes', "Changes"));
		menuButton.addEventListener('click', event => {
			event.stopPropagation();
			const nextVisible = !menu.classList.contains('visible');
			this.closeOtherPopovers(nextVisible ? 'taskSidePanelMenu' : undefined);
			menu.classList.toggle('visible', nextVisible);
			menuButton.setAttribute('aria-expanded', String(nextVisible));
		});

		const toolbarActions = dom.append(toolbar, dom.$('.microide-task-side-panel-actions'));
		const closeButton = appendIconButton(toolbarActions, Codicon.layoutSidebarRightOff, localize('microide.workbuddy.closeTaskSidePanel', "Close task panel"), 'compact secondary icon-only');
		closeButton.addEventListener('click', () => {
			this.taskSidePanelVisible = false;
			this.hideTaskBrowserView();
			this.renderState();
		});

		const body = dom.append(container, dom.$('.microide-task-side-panel-body'));
		if (this.taskSidePanelMode === 'browser') {
			this.renderTaskBrowserPanel(body);
		} else {
			this.renderTaskChangesPanel(body, state);
		}
	}
	private appendTaskSidePanelMenuItem(container: HTMLElement, mode: MicroIDETaskSidePanel, icon: ThemeIcon, label: string): void {
		const item = dom.append(container, dom.$('button.microide-task-side-panel-menu-item')) as HTMLButtonElement;
		item.type = 'button';
		item.classList.toggle('active', this.taskSidePanelMode === mode);
		appendIcon(item, icon);
		const text = dom.append(item, dom.$('span'));
		text.textContent = label;
		if (this.taskSidePanelMode === mode) {
			appendIcon(item, Codicon.check);
		}
		item.addEventListener('click', event => {
			event.stopPropagation();
			this.taskSidePanelMode = mode;
			this.closeOtherPopovers();
			this.renderState();
		});
	}

	private renderTaskBrowserPanel(container: HTMLElement): void {
		const header = dom.append(container, dom.$('.microide-task-browser-header'));
		const title = dom.append(header, dom.$('.microide-task-side-panel-title'));
		appendIcon(title, Codicon.browser);
		dom.append(title, dom.$('span')).textContent = localize('microide.workbuddy.browser', "Browser");
		const form = dom.append(container, dom.$('form.microide-task-browser-address')) as HTMLFormElement;
		const input = dom.append(form, dom.$('input')) as HTMLInputElement;
		input.type = 'text';
		input.spellcheck = false;
		input.placeholder = localize('microide.workbuddy.browserPlaceholder', "Enter URL or search terms");
		input.value = this.taskBrowserUrl === 'about:blank' ? '' : this.taskBrowserUrl;
		const go = appendIconButton(form, Codicon.arrowRight, localize('microide.workbuddy.openBrowserUrl', "Open"), 'compact primary icon-only');
		const open = (): void => {
			const nextUrl = normalizeTaskBrowserUrl(input.value);
			this.taskBrowserUrl = nextUrl;
			this.taskBrowserStatus = nextUrl === 'about:blank' ? 'idle' : 'opening';
			if (nextUrl === 'about:blank') {
				this.hideTaskBrowserView();
			} else {
				void this.openTaskBrowserUrl(nextUrl);
			}
			this.renderState();
		};
		form.addEventListener('submit', event => {
			event.preventDefault();
			open();
		});
		go.addEventListener('click', event => {
			event.preventDefault();
			open();
		});

		const frameWrap = dom.append(container, dom.$('.microide-task-browser-frame')) as HTMLElement;
		const host = dom.append(frameWrap, dom.$('.microide-task-browser-view-host')) as HTMLElement;
		this.taskBrowserFrameElement = host;
		const resizeObserver = new ResizeObserver(() => this.scheduleTaskBrowserLayout(0));
		resizeObserver.observe(host);
		this.taskSidePanelDisposables.add({ dispose: () => resizeObserver.disconnect() });

		if (this.taskBrowserUrl === 'about:blank') {
			const empty = dom.append(frameWrap, dom.$('.microide-task-side-empty.microide-task-browser-launcher'));
			appendIcon(empty, Codicon.browser);
			dom.append(empty, dom.$('strong')).textContent = localize('microide.workbuddy.browserEmptyTitle', "Open a browser view");
			dom.append(empty, dom.$('span')).textContent = localize('microide.workbuddy.browserEmptyDescription', "Open a page here. Shared BrowserView pages can be controlled by the agent browser skill.");
			this.hideTaskBrowserView();
			return;
		}

		if (this.taskBrowserStatus === 'error') {
			const empty = dom.append(frameWrap, dom.$('.microide-task-side-empty.microide-task-browser-launcher'));
			appendIcon(empty, Codicon.warning);
			dom.append(empty, dom.$('strong')).textContent = localize('microide.workbuddy.browserErrorTitle', "Browser failed to open");
			dom.append(empty, dom.$('span')).textContent = localize('microide.workbuddy.browserErrorDescription', "Check the URL and try again.");
			return;
		}

		void this.openTaskBrowserUrl(this.taskBrowserUrl);
		this.scheduleTaskBrowserLayout(0);
	}

	private async openTaskBrowserUrl(url: string): Promise<void> {
		if (url === 'about:blank') {
			this.taskBrowserStatus = 'idle';
			this.hideTaskBrowserView();
			return;
		}
		if (this.taskBrowserOpeningUrl === url) {
			this.scheduleTaskBrowserLayout(0);
			return;
		}
		if (this.taskBrowserModel?.url === url && this.taskBrowserStatus === 'opened') {
			void this.shareTaskBrowserWithAgent();
			this.scheduleTaskBrowserLayout(0);
			return;
		}

		this.taskBrowserOpeningUrl = url;
		this.taskBrowserStatus = 'opening';
		try {
			const input = this.taskBrowserInput ?? this.browserViewWorkbenchService.getOrCreateLazy(MICROIDE_TASK_BROWSER_VIEW_ID, { url, title: localize('microide.workbuddy.browserTitle', "MicroWorker Browser") });
			this.taskBrowserInput = input;
			const model = input.model ?? await input.resolve();
			this.attachTaskBrowserModel(model);
			if (model.url !== url) {
				await model.loadURL(url);
			}
			this.taskBrowserStatus = 'opened';
			void this.shareTaskBrowserWithAgent();
			this.scheduleTaskBrowserLayout(0);
		} catch (error) {
			this.taskBrowserStatus = 'error';
			this.notificationService.error(toErrorMessage(error));
		} finally {
			if (this.taskBrowserOpeningUrl === url) {
				this.taskBrowserOpeningUrl = undefined;
			}
			this.renderScheduler.schedule();
		}
	}

	private attachTaskBrowserModel(model: IBrowserViewModel): void {
		if (this.taskBrowserModel === model) {
			return;
		}
		this.taskBrowserModelDisposables.clear();
		this.taskBrowserModel = model;
		this.taskBrowserSharingRequested = false;
		this.taskBrowserModelDisposables.add(model.onDidNavigate(event => {
			if (this.taskBrowserModel !== model) {
				return;
			}
			if (event.url) {
				this.taskBrowserUrl = event.url;
				this.taskBrowserStatus = 'opened';
				this.renderScheduler.schedule();
			}
		}));
		this.taskBrowserModelDisposables.add(model.onDidChangeLoadingState(() => this.renderScheduler.schedule()));
		this.taskBrowserModelDisposables.add(model.onDidChangeSharingState(() => this.renderScheduler.schedule()));
		this.taskBrowserModelDisposables.add(model.onWillDispose(() => {
			if (this.taskBrowserModel === model) {
				this.taskBrowserModel = undefined;
				this.taskBrowserInput = undefined;
				this.taskBrowserStatus = 'idle';
				this.taskBrowserSharingRequested = false;
			}
		}));
	}

	private async shareTaskBrowserWithAgent(): Promise<void> {
		const model = this.taskBrowserModel;
		if (!model || !this.browserViewWorkbenchService.isSharingAvailable || this.taskBrowserSharingRequested || model.sharingState !== BrowserViewSharingState.NotShared) {
			return;
		}
		this.taskBrowserSharingRequested = true;
		try {
			await model.setSharedWithAgent(true);
		} catch (error) {
			this.notificationService.warn(toErrorMessage(error));
		} finally {
			this.renderScheduler.schedule();
		}
	}

	private isTaskBrowserVisible(): boolean {
		return Boolean(this.taskBrowserFrameElement)
			&& this.activeWorkbenchSurface === 'task'
			&& !this.showingNewTaskStudio
			&& this.taskSidePanelVisible
			&& this.taskSidePanelMode === 'browser'
			&& this.taskBrowserUrl !== 'about:blank';
	}

	private scheduleTaskBrowserLayout(delay = 16): void {
		this.taskBrowserLayoutScheduler.schedule(delay);
	}

	private layoutTaskBrowserView(retries = 2): void {
		const model = this.taskBrowserModel;
		const host = this.taskBrowserFrameElement;
		if (!model || !host || !this.isTaskBrowserVisible()) {
			if (model?.visible) {
				void model.setVisible(false);
			}
			return;
		}

		const rect = host.getBoundingClientRect();
		if ((rect.width <= 1 || rect.height <= 1) && retries > 0) {
			mainWindow.requestAnimationFrame(() => this.layoutTaskBrowserView(retries - 1));
			return;
		}

		const zoomFactor = getZoomFactor(mainWindow);
		const snap = (value: number): number => Math.floor(value * zoomFactor) / zoomFactor;
		const cornerRadius = parseFloat(mainWindow.getComputedStyle(host).borderTopLeftRadius ?? '0') || 0;
		const windowId = (mainWindow as Window & { readonly vscodeWindowId: number }).vscodeWindowId;
		void model.layout({
			windowId,
			x: snap(rect.left),
			y: snap(rect.top),
			width: Math.max(0, snap(rect.width)),
			height: Math.max(0, snap(rect.height)),
			zoomFactor,
			cornerRadius
		}).then(() => {
			if (this.taskBrowserModel === model && this.isTaskBrowserVisible()) {
				return model.setVisible(true);
			}
			return undefined;
		}).catch(error => this.notificationService.error(toErrorMessage(error)));
	}

	private hideTaskBrowserView(): void {
		this.taskBrowserLayoutScheduler.cancel();
		this.taskBrowserFrameElement = undefined;
		if (this.taskBrowserModel?.visible) {
			void this.taskBrowserModel.setVisible(false);
		}
	}
	private renderTaskChangesPanel(container: HTMLElement, state: IMicroIDEAgentState): void {
		const header = dom.append(container, dom.$('.microide-task-changes-header'));
		const title = dom.append(header, dom.$('.microide-task-side-panel-title'));
		appendIcon(title, Codicon.diffMultiple);
		dom.append(title, dom.$('span')).textContent = localize('microide.workbuddy.changes', "Changes");
		const changes = this.collectTaskChanges(state);
		const count = dom.append(header, dom.$('.microide-task-changes-count'));
		count.textContent = changes.length === 1 ? localize('microide.workbuddy.oneChangedFile', "1 file") : localize('microide.workbuddy.changedFiles', "{0} files", changes.length);

		if (!changes.length) {
			const empty = dom.append(container, dom.$('.microide-task-side-empty'));
			appendIcon(empty, Codicon.diffMultiple);
			dom.append(empty, dom.$('strong')).textContent = localize('microide.workbuddy.noChangesTitle', "No file changes yet");
			dom.append(empty, dom.$('span')).textContent = localize('microide.workbuddy.noChangesDescription', "Files edited in this session will appear here as collapsible diff cards.");
			return;
		}

		const list = dom.append(container, dom.$('.microide-task-changes-list'));
		const renderer = this.taskSidePanelDisposables.add(new TranscriptRenderer(list, {
			markdownRendererService: this.markdownRendererService,
			copyText: text => this.clipboardService.writeText(text),
			openPath: path => this.openWorkspacePath(path),
			openDiff: diff => this.openDiffInEditor(diff)
		}));
		for (const change of changes) {
			renderer.renderDiffPreview(list, change, this.taskSidePanelDisposables, { stateKey: 'task-side-panel-' + change.filePath, compact: true });
		}
	}

	private collectTaskChanges(state: IMicroIDEAgentState): readonly IMicroIDEDiffPreview[] {
		const seen = new Set<string>();
		const changes: IMicroIDEDiffPreview[] = [];
		for (const message of state.messages) {
			if (!message.diff || seen.has(message.diff.filePath)) {
				continue;
			}
			seen.add(message.diff.filePath);
			changes.push(message.diff);
		}
		return changes;
	}

	private renderSessionTabs(container: HTMLElement, state: IMicroIDEAgentState): void {
		dom.reset(container);
		container.setAttribute('role', 'tablist');
		container.setAttribute('aria-label', localize('microide.sessionTabsAriaLabel', "microClaude sessions"));

		const openSessions = state.sessions
			.filter(session => !session.closed)
			.slice()
			.sort((a, b) => b.createdAt - a.createdAt);
		const visibleSessions = openSessions;
		const activeSessionId = state.activeSessionId ?? state.session?.id ?? visibleSessions[0]?.id;

		for (const session of visibleSessions) {
			const active = session.id === activeSessionId;
			const editing = this.editingSessionId === session.id && this.editingSessionSurface === 'tabs';
			const tab = dom.append(container, dom.$('.microide-session-tab')) as HTMLElement;
			tab.classList.toggle('active', active);
			tab.classList.toggle('running', session.status === 'busy');
			tab.classList.toggle('editing', editing);
			tab.title = formatSessionTabTitle(session);

			const main = dom.append(tab, dom.$(editing ? 'div.microide-session-tab-main' : 'button.microide-session-tab-main')) as HTMLElement;
			if (main instanceof HTMLButtonElement) {
				main.type = 'button';
			}
			main.setAttribute('role', 'tab');
			main.setAttribute('aria-selected', String(active));
			main.tabIndex = editing ? -1 : active ? 0 : -1;
			main.title = formatSessionTabTitle(session);
			appendIcon(main, session.status === 'busy' ? Codicon.sync : active ? Codicon.circleFilled : Codicon.history);
			const copy = dom.append(main, dom.$('span.microide-session-tab-copy'));
			if (editing) {
				const input = dom.append(copy, dom.$('input.microide-session-rename-input')) as HTMLInputElement;
				input.value = this.editingSessionValue || sessionDisplayTitle(session);
				input.setAttribute('aria-label', localize('microide.renameSessionInlineAria', "Session title"));
				input.addEventListener('click', event => event.stopPropagation());
				input.addEventListener('dblclick', event => event.stopPropagation());
				input.addEventListener('input', () => this.editingSessionValue = input.value);
				input.addEventListener('keydown', event => {
					if (event.key === 'Enter') {
						event.preventDefault();
						event.stopPropagation();
						void this.commitRenameSession(session.id, input.value);
					} else if (event.key === 'Escape') {
						event.preventDefault();
						event.stopPropagation();
						this.cancelRenameSession();
					}
				});
				input.addEventListener('blur', () => {
					if (this.editingSessionId === session.id) {
						void this.commitRenameSession(session.id, input.value);
					}
				});
				setTimeout(() => {
					input.focus();
					input.select();
				}, 0);
			} else {
				const label = dom.append(copy, dom.$('span.microide-session-tab-label'));
				label.textContent = sessionDisplayTitle(session);
				const meta = dom.append(copy, dom.$('span.microide-session-tab-meta'));
				meta.textContent = sessionTabMeta(session);
			}
			if (session.status === 'busy') {
				main.classList.add('microide-session-tab-spinner');
			}
			main.addEventListener('click', event => {
				event.stopPropagation();
				if (editing) {
					return;
				}
				if (session.id !== state.activeSessionId) {
					void this.switchSession(session.id);
				}
			});
			main.addEventListener('dblclick', event => {
				event.stopPropagation();
				this.beginRenameSession(session);
			});
			main.addEventListener('contextmenu', event => {
				event.preventDefault();
				event.stopPropagation();
				this.beginRenameSession(session);
			});
			const rename = dom.append(tab, dom.$('button.microide-session-tab-rename')) as HTMLButtonElement;
			rename.type = 'button';
			rename.title = localize('microide.renameSessionTitle', "Rename {0}", session.title);
			rename.disabled = session.status === 'busy' || editing;
			appendIcon(rename, Codicon.edit);
			rename.addEventListener('click', event => {
				event.stopPropagation();
				this.beginRenameSession(session);
			});

			const close = dom.append(tab, dom.$('button.microide-session-tab-close')) as HTMLButtonElement;
			close.type = 'button';
			close.title = localize('microide.closeSessionTitle', "Close {0}", session.title);
			close.disabled = session.status === 'busy';
			appendIcon(close, Codicon.close);
			close.addEventListener('click', event => {
				event.stopPropagation();
				void this.closeSession(session.id);
			});
		}
	}

	private renderHistoryPopover(state: IMicroIDEAgentState, visible: boolean): void {
		const popover = this.historyPopoverElement;
		if (!popover) {
			return;
		}

		dom.reset(popover);
		popover.classList.toggle('visible', visible);
		this.agentModeButton?.setAttribute('aria-expanded', String(visible));
		if (!visible) {
			return;
		}

		const search = dom.append(popover, dom.$('.microide-session-history-search'));
		appendIcon(search, Codicon.search);
		const input = dom.append(search, dom.$('input.microide-session-history-input')) as HTMLInputElement;
		input.type = 'search';
		input.placeholder = localize('microide.sessionHistorySearch', "Search sessions...");
		input.value = this.sessionHistoryFilter;

		const list = dom.append(popover, dom.$('.microide-session-history-list'));
		const renderRows = (): void => {
			dom.reset(list);
			const query = this.sessionHistoryFilter.trim().toLowerCase();
			const sessions = state.sessions.filter(session => {
				if (!query) {
					return true;
				}
				return [session.title, session.summary, session.model, session.status]
					.some(value => value?.toLowerCase().includes(query));
			});

			if (!state.sessions.length || !sessions.length) {
				const empty = dom.append(list, dom.$('.microide-session-history-empty'));
				empty.textContent = state.sessions.length
					? localize('microide.noMatchingSessions', "No matching sessions")
					: localize('microide.noSessionHistory', "No sessions yet");
				return;
			}

			const sortedSessions = sessions.slice().sort((a, b) => b.updatedAt - a.updatedAt);
			for (const session of sortedSessions) {
				const editing = this.editingSessionId === session.id && this.editingSessionSurface === 'history';
				const row = dom.append(list, dom.$(editing ? 'div.microide-session-history-row' : 'button.microide-session-history-row')) as HTMLElement;
				if (row instanceof HTMLButtonElement) {
					row.type = 'button';
				}
				row.classList.toggle('active', !this.showingNewTaskStudio && session.id === state.activeSessionId);
				row.classList.toggle('editing', editing);
				appendIcon(row, session.id === state.activeSessionId ? Codicon.circleFilled : Codicon.history);
				const body = dom.append(row, dom.$('.microide-session-history-body'));
				const head = dom.append(body, dom.$('.microide-session-history-row-head'));
				if (editing) {
					const input = dom.append(head, dom.$('input.microide-session-rename-input.microide-session-history-rename-input')) as HTMLInputElement;
					input.value = this.editingSessionValue || sessionDisplayTitle(session);
					input.setAttribute('aria-label', localize('microide.renameSessionInlineAria', "Session title"));
					input.addEventListener('click', event => event.stopPropagation());
					input.addEventListener('input', () => this.editingSessionValue = input.value);
					input.addEventListener('keydown', event => {
						if (event.key === 'Enter') {
							event.preventDefault();
							event.stopPropagation();
							void this.commitRenameSession(session.id, input.value);
						} else if (event.key === 'Escape') {
							event.preventDefault();
							event.stopPropagation();
							this.cancelRenameSession();
						}
					});
					input.addEventListener('blur', () => {
						if (this.editingSessionId === session.id) {
							void this.commitRenameSession(session.id, input.value);
						}
					});
					setTimeout(() => {
						input.focus();
						input.select();
					}, 0);
				} else {
					const label = dom.append(head, dom.$('.microide-session-history-label'));
					label.textContent = session.title;
				}
				const time = dom.append(head, dom.$('.microide-session-history-time'));
				time.textContent = formatSessionTime(session.updatedAt);
				if (session.summary && session.summary !== session.title) {
					const summary = dom.append(body, dom.$('.microide-session-history-summary'));
					summary.textContent = session.summary;
				}
				const meta = dom.append(body, dom.$('.microide-session-history-meta'));
				meta.textContent = [session.status, session.model].filter(Boolean).join(' / ');
				const statsText = formatSessionStats(session);
				if (statsText) {
					const stats = dom.append(body, dom.$('.microide-session-history-stats'));
					for (const stat of statsText.split(' / ')) {
						const chip = dom.append(stats, dom.$('span.microide-session-history-stat'));
						chip.textContent = stat;
					}
				}
				row.addEventListener('click', () => {
					if (!editing) {
						void this.switchSession(session.id);
					}
				});
				row.addEventListener('contextmenu', event => {
					event.preventDefault();
					this.beginRenameSession(session, 'history');
				});
			}
		};
		input.addEventListener('input', () => {
			this.sessionHistoryFilter = input.value;
			renderRows();
		});
		input.addEventListener('keydown', event => {
			if (event.key === 'Escape') {
				event.preventDefault();
				popover.classList.remove('visible');
				this.historyButton?.focus();
			}
		});
		renderRows();
		input.focus();
	}

	private renderEngine(container: HTMLElement, state: IMicroIDEAgentState): void {
		dom.reset(container);

		// The healthy "ready" state needs no strip �?keep the panel clean. Only surface the strip
		// for states the user must act on: sidecar error, startup, or a degraded fallback engine.
		const shouldShow = state.status === 'error' || state.status === 'starting' || state.engineDegraded;
		container.classList.toggle('hidden', !shouldShow);
		if (!shouldShow) {
			container.className = 'microide-engine-strip hidden';
			return;
		}

		container.className = 'microide-engine-strip';
		container.classList.toggle('ready', state.status !== 'error');
		container.classList.toggle('degraded', state.engineDegraded);

		appendIcon(container, state.status === 'error' ? Codicon.error : state.engineDegraded ? Codicon.warning : Codicon.sync);
		const label = dom.append(container, dom.$('span.microide-engine-label'));
		if (state.status === 'error') {
			label.textContent = localize('microide.sidecarUnavailable', "microClaude sidecar unavailable");
		} else if (state.status === 'starting') {
			label.textContent = localize('microide.sidecarStarting', "microClaude sidecar starting");
		} else {
			label.textContent = localize('microide.sidecarDegraded', "Fallback engine ({0})", state.engine ?? 'lightweight');
		}

		const meta = dom.append(container, dom.$('span.microide-engine-meta'));
		meta.textContent = formatRuntimeMeta(state);
	}

	private renderTeamStrip(container: HTMLElement, state: IMicroIDEAgentState): void {
		dom.reset(container);
		const team = state.team;
		const shouldShow = state.agentMode === 'multiAgent'
			|| team.status !== 'inactive'
			|| team.members.length > 0
			|| team.tasks.length > 0
			|| team.messages.length > 0;
		container.className = `microide-team-strip${shouldShow ? '' : ' hidden'} status-${team.status}`;
		if (!shouldShow) {
			return;
		}

		const head = dom.append(container, dom.$('.microide-team-head'));
		appendIcon(head, Codicon.organization);
		const title = dom.append(head, dom.$('.microide-team-title'));
		const hasTeamActivity = team.status !== 'inactive'
			|| team.members.length > 0
			|| team.tasks.length > 0
			|| team.messages.length > 0;
		title.textContent = team.teamName ?? (hasTeamActivity
			? localize('microide.teamWaitingTitle', "Agent team")
			: localize('microide.teamDeferredTitle', "Multi-Agent mode"));
		const meta = dom.append(head, dom.$('.microide-team-meta'));
		meta.textContent = hasTeamActivity
			? [
				teamStatusLabel(team.status),
				localize('microide.teamMembersCount', "{0} agents", team.members.length),
				localize('microide.teamTasksCount', "{0} tasks", team.tasks.length)
			].join(' / ')
			: localize('microide.teamDeferredMeta', "Team starts when the next task needs specialists");

		if (team.teamFilePath) {
			const file = dom.append(head, dom.$('.microide-team-file'));
			file.textContent = pathBasename(team.teamFilePath);
			file.title = team.teamFilePath;
		}

		if (!hasTeamActivity) {
			const deferred = dom.append(container, dom.$('.microide-team-deferred'));
			appendIcon(deferred, Codicon.sparkle);
			const text = dom.append(deferred, dom.$('span'));
			text.textContent = localize('microide.teamDeferredBody', "No team is running yet. microClaude will create teammates dynamically after you send a multi-agent task.");
			return;
		}

		const body = dom.append(container, dom.$('.microide-team-body'));
		const summary = dom.append(body, dom.$('.microide-team-summary'));
		this.renderTeamSummary(summary, team);

		const members = dom.append(body, dom.$('.microide-team-members'));
		for (const member of team.members.slice(0, 6)) {
			const row = dom.append(members, dom.$(`.microide-team-member.status-${member.status}`));
			appendIcon(row, member.status === 'running' ? Codicon.sync : member.status === 'stopped' ? Codicon.circleSlash : Codicon.account);
			const text = dom.append(row, dom.$('.microide-team-member-text'));
			const titleLine = dom.append(text, dom.$('.microide-team-member-name'));
			titleLine.textContent = member.name;
			const meta = dom.append(text, dom.$('.microide-team-member-meta'));
			meta.textContent = [member.agentType, member.model, member.backend].filter(Boolean).join(' / ');
			row.title = [member.name, member.agentType, member.model, member.backend].filter(Boolean).join(' / ');
		}
		if (team.members.length > 6) {
			const more = dom.append(members, dom.$('.microide-team-more'));
			more.textContent = localize('microide.teamMoreMembers', "+{0}", team.members.length - 6);
		}
		if (!team.members.length) {
			const waiting = dom.append(members, dom.$('.microide-team-waiting'));
			waiting.textContent = localize('microide.teamWaitingMembers', "Waiting for teammates");
		}

		const tasks = dom.append(body, dom.$('.microide-team-tasks'));
		for (const task of team.tasks.slice(0, 3)) {
			this.appendTeamTask(tasks, task);
		}
		if (!team.tasks.length) {
			const emptyTask = dom.append(tasks, dom.$('.microide-team-empty'));
			emptyTask.textContent = localize('microide.teamNoTasks', "No team tasks yet");
		}

		const messages = dom.append(body, dom.$('.microide-team-messages'));
		const recentMessages = team.messages.slice(-3);
		if (recentMessages.length) {
			for (const msg of recentMessages) {
				const row = dom.append(messages, dom.$('.microide-team-message'));
				appendIcon(row, Codicon.comment);
				const text = dom.append(row, dom.$('.microide-team-message-text'));
				const sender = msg.from ? `${msg.from}: ` : '';
				text.textContent = `${sender}${msg.summary ?? msg.text ?? ''}`;
				text.title = msg.text ?? msg.summary ?? '';
			}
		} else {
			const emptyMessage = dom.append(messages, dom.$('.microide-team-empty'));
			emptyMessage.textContent = localize('microide.teamNoMessages', "No teammate messages yet");
		}
	}

	private renderTeamSummary(container: HTMLElement, team: IMicroIDEAgentTeamState): void {
		dom.reset(container);
		container.classList.add('microide-team-summary');
		const activeMembers = team.members.filter(member => member.status === 'running').length;
		const inactiveMembers = team.members.filter(member => member.status === 'idle' || member.status === 'stopped').length;
		const blocks: Array<{ label: string; value: string; tone?: 'good' | 'warning' | 'neutral' }> = [
			{ label: localize('microide.teamSummaryActive', "Active"), value: String(activeMembers), tone: activeMembers > 0 ? 'good' : 'neutral' },
			{ label: localize('microide.teamSummaryTasks', "Tasks"), value: String(team.tasks.length), tone: team.tasks.some(task => /running|in[_-]?progress|blocked|failed|error/i.test(task.status)) ? 'warning' : 'neutral' },
			{ label: localize('microide.teamSummaryMessages', "Msgs"), value: String(team.messages.length), tone: team.messages.length > 0 ? 'good' : 'neutral' }
		];
		for (const block of blocks) {
			const pill = dom.append(container, dom.$(`.microide-team-summary-pill.tone-${block.tone ?? 'neutral'}`));
			const value = dom.append(pill, dom.$('.microide-team-summary-value'));
			value.textContent = block.value;
			const label = dom.append(pill, dom.$('.microide-team-summary-label'));
			label.textContent = block.label;
		}
		if (inactiveMembers > 0) {
			const idle = dom.append(container, dom.$('.microide-team-summary-idle'));
			idle.textContent = localize('microide.teamSummaryIdle', "{0} idle", inactiveMembers);
		}
	}

	private appendTeamTask(container: HTMLElement, task: IMicroIDEAgentTeamTask): void {
		const row = dom.append(container, dom.$(`.microide-team-task.status-${cssToken(task.status)}`));
		appendIcon(row, taskStatusIcon(task.status));
		const subject = dom.append(row, dom.$('.microide-team-task-subject'));
		subject.textContent = task.subject;
		subject.title = task.subject;
		const meta = dom.append(row, dom.$('.microide-team-task-meta'));
		meta.textContent = [task.owner, task.status].filter(Boolean).join(' / ');
	}

	private renderPermissionPrompt(state: IMicroIDEAgentState): void {
		const host = this.permissionPromptElement;
		if (!host) {
			return;
		}

		// Surface the oldest pending request as a focused, dedicated prompt above the composer �?		// deliberately separate from the permission-mode popover.
		const pending = state.permissions.filter(request => request.state === 'pending');
		const request = pending.length ? [...pending].sort((a, b) => a.createdAt - b.createdAt)[0] : undefined;
		if (!request) {
			if (host.classList.contains('visible')) {
				this.permissionPromptDisposables.clear();
				dom.reset(host);
				host.classList.remove('visible', 'ask-user');
				host.dataset['requestId'] = '';
				host.dataset['proposalRequestId'] = '';
				host.removeAttribute('role');
				host.removeAttribute('aria-modal');
				host.removeAttribute('aria-label');
				host.onkeydown = null;
			}
			return;
		}

		if (request.diff && host.dataset['proposalRequestId'] !== request.requestId) {
			host.dataset['proposalRequestId'] = request.requestId;
			void this.microIDEDiffService.openProposedChange(request.diff, { requestId: request.requestId }).catch(error => this.notificationService.error(toErrorMessage(error)));
		}

		// Avoid rebuilding (and stealing focus from the "instead" field) when nothing changed.
		if (host.dataset['requestId'] === request.requestId && host.classList.contains('visible')) {
			return;
		}
		host.dataset['requestId'] = request.requestId;

		this.permissionPromptDisposables.clear();
		dom.reset(host);
		host.onkeydown = null;
		const askUserInput = parseAskUserQuestionInput(request.input);
		if (isAskUserQuestionToolName(request.toolName) && askUserInput) {
			this.renderAskUserQuestionPrompt(host, request, askUserInput);
			return;
		}

		host.classList.add('visible');
		host.classList.remove('ask-user');
		host.removeAttribute('role');
		host.removeAttribute('aria-modal');
		host.removeAttribute('aria-label');
		const card = dom.append(host, dom.$('.microide-permission-prompt-card'));

		const title = dom.append(card, dom.$('.microide-permission-prompt-title'));
		title.textContent = permissionPromptTitle(request);

		if (request.command) {
			const detail = dom.append(card, dom.$('.microide-permission-prompt-command'));
			detail.textContent = request.command;
		}
		if (request.summary && request.summary !== request.command && request.summary !== request.path) {
			const summary = dom.append(card, dom.$('.microide-permission-prompt-summary'));
			summary.textContent = request.summary;
		}

		const options = dom.append(card, dom.$('.microide-permission-prompt-options'));
		const addOption = (index: number, label: string, primary: boolean, run: () => void): void => {
			const option = dom.append(options, dom.$(`button.microide-permission-prompt-option${primary ? '.primary' : ''}`)) as HTMLButtonElement;
			option.type = 'button';
			const key = dom.append(option, dom.$('span.microide-permission-prompt-option-key'));
			key.textContent = String(index);
			const text = dom.append(option, dom.$('span.microide-permission-prompt-option-label'));
			text.textContent = label;
			option.addEventListener('click', run);
		};

		addOption(1, localize('microide.permissionYes', "Yes"), true, () => void this.resolvePromptApprove(request));
		addOption(2, localize('microide.permissionYesAllEditsSession', "Yes, allow all edits this session"), false, () => void this.resolvePromptApproveProject(request));
		addOption(3, localize('microide.permissionNo', "No"), false, () => void this.resolvePromptDeny(request));

		const instead = dom.append(card, dom.$('input.microide-permission-prompt-instead')) as HTMLInputElement;
		instead.type = 'text';
		instead.placeholder = localize('microide.permissionInsteadClaude', "Tell Claude what to do instead");
		instead.addEventListener('keydown', e => {
			if (e.key === 'Enter' && instead.value.trim()) {
				e.preventDefault();
				void this.resolvePromptDeny(request, instead.value.trim());
			} else if (e.key === 'Escape') {
				e.preventDefault();
				void this.resolvePromptDeny(request);
			}
		});

		const cancel = dom.append(card, dom.$('.microide-permission-prompt-cancel'));
		cancel.textContent = localize('microide.permissionEscCancel', "Esc to cancel");

		// Number-key shortcuts (1/2/3) when focus is not in the "instead" input.
		host.onkeydown = e => {
			if (host.dataset['requestId'] !== request.requestId || host.ownerDocument.activeElement === instead) {
				return;
			}
			if (e.key === '1') {
				void this.resolvePromptApprove(request);
			} else if (e.key === '2') {
				void this.resolvePromptApproveProject(request);
			} else if (e.key === '3') {
				void this.resolvePromptDeny(request);
			}
		};
	}

	private renderAskUserQuestionPrompt(host: HTMLElement, request: IMicroIDEPermissionRequest, askUserInput: IMicroIDEAskUserQuestionInput): void {
		host.classList.add('visible', 'ask-user');
		host.setAttribute('role', 'dialog');
		host.setAttribute('aria-modal', 'true');
		host.setAttribute('aria-label', localize('microide.askUserQuestionAriaLabel', "Question from microClaude"));

		const backdrop = dom.append(host, dom.$('.microide-ask-user-backdrop'));
		backdrop.addEventListener('click', () => void this.resolvePromptDeny(request));

		const card = dom.append(host, dom.$('.microide-ask-user-card'));
		card.tabIndex = -1;
		card.addEventListener('click', event => event.stopPropagation());

		const header = dom.append(card, dom.$('.microide-ask-user-header'));
		const heading = dom.append(header, dom.$('.microide-ask-user-heading'));
		const title = dom.append(heading, dom.$('.microide-ask-user-title'));
		title.textContent = askUserQuestionDialogTitle(askUserInput);
		const meta = dom.append(heading, dom.$('.microide-ask-user-meta'));
		meta.textContent = askUserQuestionDialogMeta(askUserInput);

		const close = dom.append(header, dom.$('button.microide-ask-user-close')) as HTMLButtonElement;
		close.type = 'button';
		close.title = localize('microide.askUserQuestionClose', "Cancel");
		appendIcon(close, Codicon.close);
		close.addEventListener('click', () => void this.resolvePromptDeny(request));

		const body = dom.append(card, dom.$('.microide-ask-user-body'));
		const initialAnswers = askUserInput.answers ?? {};
		type AskUserChoiceRow = {
			readonly element: HTMLElement;
			readonly input: HTMLInputElement;
			readonly label?: string;
			readonly preview?: string;
			readonly otherInput?: HTMLInputElement;
		};
		const controls: {
			readonly question: IMicroIDEAskUserQuestion;
			readonly rows: AskUserChoiceRow[];
		}[] = [];

		let submit: HTMLButtonElement | undefined;

		const collectResponse = (): { readonly answers: Record<string, string>; readonly annotations?: Record<string, unknown> } | undefined => {
			const answers: Record<string, string> = {};
			const annotations: Record<string, unknown> = {};
			for (const control of controls) {
				const selectedRows = control.rows.filter(row => row.input.checked);
				const values = selectedRows
					.map(row => row.otherInput ? row.otherInput.value.trim() : row.label)
					.filter((value): value is string => Boolean(value));
				if (values.length === 0) {
					return undefined;
				}
				if (control.rows.some(row => row.input.checked && row.otherInput && !row.otherInput.value.trim())) {
					return undefined;
				}
				answers[control.question.question] = values.join(', ');
				const previewRow = selectedRows.find(row => row.preview);
				if (previewRow?.preview) {
					annotations[control.question.question] = { preview: previewRow.preview };
				}
			}
			return {
				answers,
				...(Object.keys(annotations).length ? { annotations } : {})
			};
		};

		const refresh = (): void => {
			for (const control of controls) {
				for (const row of control.rows) {
					row.element.classList.toggle('selected', row.input.checked);
				}
			}
			if (submit) {
				submit.disabled = !collectResponse();
			}
		};

		askUserInput.questions.forEach((question, questionIndex) => {
			const group = dom.append(body, dom.$('.microide-ask-user-question'));
			if (askUserInput.questions.length > 1 || question.header) {
				const chip = dom.append(group, dom.$('.microide-ask-user-question-chip'));
				chip.textContent = question.header || localize('microide.askUserQuestionIndex', "Question {0}", questionIndex + 1);
			}

			const prompt = dom.append(group, dom.$('.microide-ask-user-question-text'));
			prompt.textContent = question.question;

			const hasPreview = !question.multiSelect && question.options.some(option => option.preview);
			const layout = dom.append(group, dom.$(`.microide-ask-user-choice-layout${hasPreview ? '.with-preview' : ''}`));
			const options = dom.append(layout, dom.$('.microide-ask-user-options'));
			const inputName = `microide-ask-user-${sanitizeIdFragment(request.requestId)}-${questionIndex}`;
			const initialValues = splitAskUserAnswer(initialAnswers[question.question]);
			const optionLabels = new Set(question.options.map(option => option.label));
			const rows: AskUserChoiceRow[] = [];
			let setPreview: (row?: AskUserChoiceRow) => void = () => {};

			if (hasPreview) {
				const preview = dom.append(layout, dom.$('.microide-ask-user-preview'));
				const previewHeader = dom.append(preview, dom.$('.microide-ask-user-preview-header'));
				appendIcon(previewHeader, Codicon.preview);
				const previewTitle = dom.append(previewHeader, dom.$('span.microide-ask-user-preview-title'));
				const previewBody = dom.append(preview, dom.$('.microide-ask-user-preview-body.markdown'));
				const previewDisposables = this.permissionPromptDisposables.add(new DisposableStore());

				setPreview = (row?: AskUserChoiceRow): void => {
					previewDisposables.clear();
					dom.reset(previewBody);
					const previewContent = row?.preview?.trim();
					previewTitle.textContent = row?.label ?? localize('microide.askUserQuestionPreviewTitle', "Preview");
					previewBody.classList.toggle('empty', !previewContent);
					if (!previewContent) {
						previewBody.textContent = localize('microide.askUserQuestionNoPreview', "No preview available");
						return;
					}
					const rendered = previewDisposables.add(this.markdownRendererService.render(new MarkdownString(previewContent, { isTrusted: false, supportThemeIcons: true, supportHtml: true }), {}));
					previewBody.appendChild(rendered.element);
				};
			}

			for (const option of question.options) {
				const row = dom.append(options, dom.$('label.microide-ask-user-option')) as HTMLLabelElement;
				const choice = dom.append(row, dom.$('input.microide-ask-user-choice')) as HTMLInputElement;
				choice.type = question.multiSelect ? 'checkbox' : 'radio';
				choice.name = inputName;
				choice.checked = initialValues.includes(option.label);

				const copy = dom.append(row, dom.$('.microide-ask-user-option-copy'));
				const label = dom.append(copy, dom.$('.microide-ask-user-option-label'));
				label.textContent = option.label;
				if (option.description) {
					const description = dom.append(copy, dom.$('.microide-ask-user-option-description'));
					description.textContent = option.description;
				}

				const rowState: AskUserChoiceRow = {
					element: row,
					input: choice,
					label: option.label,
					...(option.preview ? { preview: option.preview } : {})
				};
				choice.addEventListener('change', () => {
					setPreview(rowState);
					refresh();
				});
				choice.addEventListener('focus', () => setPreview(rowState));
				row.addEventListener('mouseenter', () => setPreview(rowState));
				rows.push(rowState);
			}

			const unmatched = initialValues.filter(value => !optionLabels.has(value)).join(', ');
			const otherRow = dom.append(options, dom.$('.microide-ask-user-option.other'));
			const otherChoice = dom.append(otherRow, dom.$('input.microide-ask-user-choice')) as HTMLInputElement;
			otherChoice.type = question.multiSelect ? 'checkbox' : 'radio';
			otherChoice.name = inputName;
			otherChoice.checked = Boolean(unmatched);
			const otherCopy = dom.append(otherRow, dom.$('.microide-ask-user-option-copy'));
			const otherLabel = dom.append(otherCopy, dom.$('.microide-ask-user-option-label'));
			otherLabel.textContent = localize('microide.askUserQuestionOther', "Other");
			const otherText = dom.append(otherCopy, dom.$('input.microide-ask-user-other-input')) as HTMLInputElement;
			otherText.type = 'text';
			otherText.placeholder = localize('microide.askUserQuestionOtherPlaceholder', "Type a custom answer");
			otherText.value = unmatched;
			otherChoice.addEventListener('change', () => {
				if (otherChoice.checked) {
					otherText.focus();
				}
				setPreview();
				refresh();
			});
			otherText.addEventListener('focus', () => {
				otherChoice.checked = true;
				setPreview();
				refresh();
			});
			otherText.addEventListener('input', refresh);
			otherRow.addEventListener('click', event => {
				if (event.target === otherText || event.target === otherChoice) {
					return;
				}
				otherChoice.checked = true;
				otherText.focus();
				setPreview();
				refresh();
			});
			otherRow.addEventListener('mouseenter', () => setPreview());
			rows.push({ element: otherRow, input: otherChoice, otherInput: otherText });
			setPreview(rows.find(row => row.input.checked) ?? rows.find(row => row.preview));

			controls.push({ question, rows });
		});

		const footer = dom.append(card, dom.$('.microide-ask-user-footer'));
		const cancel = dom.append(footer, dom.$('.microide-ask-user-cancel'));
		cancel.textContent = localize('microide.permissionEscCancel', "Esc to cancel");
		submit = dom.append(footer, dom.$('button.microide-ask-user-submit')) as HTMLButtonElement;
		submit.type = 'button';
		appendIcon(submit, Codicon.check);
		const submitLabel = dom.append(submit, dom.$('span'));
		submitLabel.textContent = localize('microide.askUserQuestionSubmit', "Submit answers");
		submit.addEventListener('click', () => {
			const response = collectResponse();
			if (!response) {
				refresh();
				return;
			}
			const inputRecord = asObjectRecord(request.input) ?? {};
			const existingAnnotations = asObjectRecord(inputRecord['annotations']);
			const annotations = response.annotations ? { ...(existingAnnotations ?? {}), ...response.annotations } : existingAnnotations;
			void this.resolvePromptApprove(request, undefined, {
				...inputRecord,
				questions: askUserInput.questions,
				answers: response.answers,
				...(annotations ? { annotations } : {})
			});
		});

		host.onkeydown = event => {
			if (event.key === 'Escape') {
				event.preventDefault();
				void this.resolvePromptDeny(request);
			} else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && submit && !submit.disabled) {
				event.preventDefault();
				submit.click();
			}
		};

		refresh();
		setTimeout(() => {
			const focusTarget = card.querySelector<HTMLInputElement>('input.microide-ask-user-choice:not(:checked)') ?? card.querySelector<HTMLInputElement>('input.microide-ask-user-choice') ?? close;
			focusTarget.focus();
		}, 0);
	}

	private async resolvePromptApprove(request: IMicroIDEPermissionRequest, reason?: string, updatedInput?: unknown, updatedPermissions?: readonly unknown[]): Promise<void> {
		try {
			await this.microIDEAgentService.approvePermission(request.requestId, reason, updatedInput, updatedPermissions);
		} catch (error) {
			this.notificationService.error(toErrorMessage(error));
		}
	}

	private async resolvePromptApproveProject(request: IMicroIDEPermissionRequest): Promise<void> {
		try {
			await this.microIDEAgentService.approveAllEditsForSession(request.requestId);
		} catch (error) {
			this.notificationService.error(toErrorMessage(error));
		}
	}

	private async resolvePromptDeny(request: IMicroIDEPermissionRequest, reason?: string): Promise<void> {
		try {
			await this.microIDEAgentService.denyPermission(request.requestId, reason);
		} catch (error) {
			this.notificationService.error(toErrorMessage(error));
		}
	}

	private renderComposer(container: HTMLElement, state: IMicroIDEAgentState): void {
		// Preserve the in-progress draft (and caret/focus) across rebuilds so interacting with
		// the model / permission / history controls never discards what the user has typed.
		const previousValue = this.inputElement?.value ?? '';
		const previousSelectionStart = this.inputElement?.selectionStart ?? null;
		const previousSelectionEnd = this.inputElement?.selectionEnd ?? null;
		const hadFocus = !!this.inputElement && this.inputElement.ownerDocument.activeElement === this.inputElement;

		dom.reset(container);
		this.inputElement = undefined;
		this.contextMeterElement = undefined;
		this.commandPaletteElement = undefined;
		this.attachmentsElement = undefined;
		this.contextElement = undefined;
		this.mentionPopoverElement = undefined;
		this.permissionPopoverElement = undefined;
		this.agentModeButton = undefined;
		this.agentModePopoverElement = undefined;
		this.turnButton = undefined;
		this.permissionModeButton = undefined;
		this.modelButton = undefined;
		this.modelPopoverElement = undefined;
		this.skillsButton = undefined;
		this.skillsPopoverElement = undefined;
		this.connectorsButton = undefined;
		this.connectorsPopoverElement = undefined;
		this.workspaceButton = undefined;
		this.workspacePopoverElement = undefined;

		const isTaskFollowUpComposer = this.activeWorkbenchSurface === 'task' && !this.showingNewTaskStudio && this.hasTaskMessages(state);
		const isBusy = isTurnRunning(state);
		const composerShell = dom.append(container, dom.$('.microide-composer-shell'));
		const composerHead = dom.append(composerShell, dom.$('.microide-workbuddy-composer-head'));
		const composerTitle = dom.append(composerHead, dom.$('.microide-workbuddy-composer-title'));
		composerTitle.textContent = isTaskFollowUpComposer
			? localize('microide.workbuddy.followUpComposerTitle', "Follow up")
			: localize('microide.workbuddy.composerTitle', "New task");
		const composerMeta = dom.append(composerHead, dom.$('.microide-workbuddy-composer-meta'));
		composerMeta.textContent = state.turnStatus ? turnPhaseLabel(state.turnStatus.phase) : permissionModeShortLabel(state.permissionMode);
		this.attachmentsElement = dom.append(composerShell, dom.$('.microide-composer-attachments'));
		this.inputElement = dom.append(composerShell, dom.$('textarea.microide-agent-input')) as HTMLTextAreaElement;
		this.inputElement.rows = 3;
		this.inputElement.placeholder = isBusy
			? localize('microide.promptPlaceholderBusy', "Queue another message...")
			: localize('microide.promptPlaceholder', "Ask MicroWorker to plan, edit, test, or document... @ files, / skills");
		this.inputElement.value = previousValue;
		this.commandPaletteElement = dom.append(composerShell, dom.$('.microide-command-palette'));
		this.mentionPopoverElement = dom.append(composerShell, dom.$('.microide-mention-palette'));
		this.inputElement.addEventListener('keydown', event => {
			const commandPaletteVisible = Boolean(this.commandPaletteElement?.classList.contains('visible'));
			const mentionPaletteVisible = Boolean(this.mentionPopoverElement?.classList.contains('visible'));
			const isPlainEnter = (event.key === 'Enter' || event.key === 'Return') && !event.shiftKey && !event.isComposing;
			const shouldAcceptPalette = event.key === 'Tab' || isPlainEnter;
			if (event.key === 'Escape' && isTurnRunning(this.microIDEAgentService.getState())) {
				event.preventDefault();
				void this.cancelPrompt();
			} else if (mentionPaletteVisible && (event.key === 'ArrowDown' || event.key === 'Down')) {
				event.preventDefault();
				this.moveMentionSelection(1);
			} else if (mentionPaletteVisible && (event.key === 'ArrowUp' || event.key === 'Up')) {
				event.preventDefault();
				this.moveMentionSelection(-1);
			} else if (event.key === 'Escape' && (commandPaletteVisible || mentionPaletteVisible)) {
				event.preventDefault();
				this.commandPaletteElement?.classList.remove('visible');
				this.mentionPopoverElement?.classList.remove('visible');
			} else if (shouldAcceptPalette && commandPaletteVisible) {
				event.preventDefault();
				this.acceptFirstCommandSuggestion();
			} else if (shouldAcceptPalette && mentionPaletteVisible) {
				event.preventDefault();
				this.acceptSelectedMentionSuggestion();
			} else if (isPlainEnter) {
				// Enter sends; Shift+Enter inserts a newline.
				event.preventDefault();
				void this.submitPrompt();
			}
		});
		this.inputElement.addEventListener('input', () => {
			this.syncPendingMentionContextsFromInput();
			this.updateCommandPalette();
			void this.updateMentionPalette();
			this.updateTurnButtonState();
			this.renderContextMeter(this.microIDEAgentService.getState());
		});
		this.inputElement.addEventListener('focus', () => {
			this.historyPopoverElement?.classList.remove('visible');
			this.agentModePopoverElement?.classList.remove('visible');
			this.agentModeButton?.setAttribute('aria-expanded', 'false');
			this.permissionPopoverElement?.classList.remove('visible');
			this.modelPopoverElement?.classList.remove('visible');
		});
		this.inputElement.addEventListener('paste', event => this.handleComposerPaste(event));
		this.inputElement.addEventListener('dragover', event => {
			if (event.dataTransfer?.types?.includes('Files')) {
				event.preventDefault();
			}
		});
		this.inputElement.addEventListener('drop', event => this.handleComposerDrop(event));
		this.renderAttachments();

		const footer = dom.append(composerShell, dom.$('.microide-composer-footer'));
		const controls = dom.append(footer, dom.$('.microide-composer-controls'));
		const agentAnchor = dom.append(controls, dom.$('.microide-popover-anchor'));
		this.agentModeButton = dom.append(agentAnchor, dom.$('button.microide-agent-mode-button')) as HTMLButtonElement;
		this.agentModeButton.type = 'button';
		this.agentModeButton.title = localize('microide.agentMode', "Agent mode");
		this.renderAgentModeButton(state);
		this.agentModePopoverElement = dom.append(agentAnchor, dom.$('.microide-agent-mode-popover'));
		this.agentModeButton.disabled = state.status === 'busy' || state.status === 'error';
		this.agentModeButton.addEventListener('click', () => this.toggleAgentModePopover());


		const skillsAnchor = dom.append(controls, dom.$('.microide-popover-anchor'));
		this.skillsButton = this.appendComposerChip(
			skillsAnchor,
			Codicon.extensions,
			localize('microide.workbuddy.skills', "Skills"),
			undefined,
			localize('microide.workbuddy.skillsTitle', "Search and use installed skills"),
			state.status === 'error',
			() => this.toggleSkillsPopover(this.microIDEAgentService.getState())
		);
		this.skillsButton.setAttribute('aria-haspopup', 'true');
		this.skillsPopoverElement = dom.append(skillsAnchor, dom.$('.microide-workbuddy-popover.skills'));

		const permissionAnchor = dom.append(controls, dom.$('.microide-popover-anchor'));
		this.permissionModeButton = dom.append(permissionAnchor, dom.$('button.microide-permission-mode-button')) as HTMLButtonElement;
		this.permissionModeButton.type = 'button';
		this.permissionModeButton.title = localize('microide.permissionModeButton', "Permission mode");
		appendIcon(this.permissionModeButton, permissionModeIcon(state.permissionMode));
		const modeLabel = dom.append(this.permissionModeButton, dom.$('span.microide-permission-mode-label'));
		modeLabel.textContent = permissionModeShortLabel(state.permissionMode);
		appendIcon(this.permissionModeButton, Codicon.chevronDown);
		if (state.permissions.some(request => request.state === 'pending')) {
			this.permissionModeButton.classList.add('pending');
		}
		this.permissionPopoverElement = dom.append(permissionAnchor, dom.$('.microide-permission-popover'));
		this.permissionModeButton.addEventListener('click', () => this.togglePermissionPopover(state));

		const modelAnchor = dom.append(controls, dom.$('.microide-popover-anchor'));
		this.modelButton = dom.append(modelAnchor, dom.$('button.microide-model-button')) as HTMLButtonElement;
		this.modelButton.type = 'button';
		this.modelButton.title = localize('microide.modelPicker', "microClaude model");
		this.modelPopoverElement = dom.append(modelAnchor, dom.$('.microide-model-popover'));
		this.renderModelButton(state);
		this.modelButton.disabled = state.status === 'busy' || state.status === 'error';
		this.modelButton.addEventListener('click', () => this.toggleModelPopover(state));

		const workspaceAnchor = dom.append(controls, dom.$('.microide-popover-anchor'));
		const workspaceFolders = this.workspaceContextService.getWorkspace().folders;
		this.workspaceButton = this.appendComposerChip(
			workspaceAnchor,
			Codicon.folder,
			localize('microide.workbuddy.workspaceButton', "Workspace"),
			workspaceFolders[0]?.name ?? localize('microide.workbuddy.noWorkspaceShort', "None"),
			localize('microide.workbuddy.workspaceTitle', "Select task workspace context"),
			state.status === 'error',
			() => this.toggleWorkspacePopover(this.microIDEAgentService.getState())
		);
		this.workspaceButton.setAttribute('aria-haspopup', 'true');
		this.workspacePopoverElement = dom.append(workspaceAnchor, dom.$('.microide-workbuddy-popover.workspace'));

		this.contextElement = dom.append(controls, dom.$('.microide-composer-contexts'));
		this.renderFileContexts();

		const actions = dom.append(footer, dom.$('.microide-agent-actions'));
		this.contextMeterElement = dom.append(actions, dom.$('.microide-context-meter'));
		this.contextMeterElement.setAttribute('role', 'meter');
		this.contextMeterElement.setAttribute('aria-valuemin', '0');
		this.contextMeterElement.setAttribute('aria-valuemax', '100');
		dom.append(this.contextMeterElement, dom.$('.microide-context-meter-core'));
		this.renderContextMeter(state);
		const addContextButton = appendIconButton(actions, Codicon.add, localize('microide.workbuddy.addContext', "Add context"), 'secondary icon-only composer-action');
		addContextButton.disabled = isBusy || state.status === 'error';
		addContextButton.addEventListener('click', () => this.openComposerFileSearch());
		const improveButton = appendIconButton(actions, Codicon.sparkle, localize('microide.workbuddy.improvePrompt', "Improve prompt"), 'secondary icon-only composer-action');
		improveButton.disabled = isBusy || state.status === 'error' || this.improvingPrompt;
		improveButton.classList.toggle('running', this.improvingPrompt);
		improveButton.addEventListener('click', () => void this.improveComposerPrompt(improveButton));
		this.turnButton = appendIconButton(
			actions,
			isBusy ? Codicon.debugStop : Codicon.arrowUp,
			isBusy ? localize('microide.pauseGenerationEsc', "Pause generation (Esc)") : localize('microide.send', "Send"),
			isBusy ? 'primary stopping icon-only turn' : 'primary icon-only turn'
		);
		this.turnButton.setAttribute('aria-label', isBusy ? localize('microide.pauseGenerationEscAria', "Pause generation. Press Escape to stop.") : localize('microide.sendAria', "Send message"));
		this.turnButton.disabled = state.status === 'error';
		this.inputElement.disabled = state.status === 'error';
		this.inputElement.placeholder = isBusy
			? localize('microide.promptPlaceholderBusy', "Queue another message...")
			: localize('microide.promptPlaceholder', "Ask MicroWorker to plan, edit, test, or document... @ files, / skills");
		this.turnButton.addEventListener('click', () => {
			if (isTurnRunning(this.microIDEAgentService.getState())) {
				void this.cancelPrompt();
			} else {
				void this.submitPrompt();
			}
		});
		this.updateCommandPalette();
		this.updateTurnButtonState();
		this.renderPermissionPopover(state, false);
		this.renderSkillsPopover(state, false);
		this.renderWorkspacePopover(state, false);

		// Restore caret position and focus so a re-render mid-typing is invisible to the user.
		if (previousSelectionStart !== null && previousSelectionEnd !== null) {
			try {
				this.inputElement.setSelectionRange(previousSelectionStart, previousSelectionEnd);
			} catch {
				// Ignore: selection range can be out of bounds if the value changed externally.
			}
		}
		if (hadFocus && !this.inputElement.disabled) {
			this.inputElement.focus();
		}
	}

	/**
	 * Reflects whether there is sendable content: the send button is highlighted (enabled) when
	 * the composer has text or attachments, and dimmed (disabled) otherwise. No-op while busy,
	 * where the button acts as Stop.
	 */
	private updateTurnButtonState(): void {
		const button = this.turnButton;
		if (!button) {
			return;
		}
		const state = this.microIDEAgentService.getState();
		if (isTurnRunning(state)) {
			button.classList.remove('empty');
			button.disabled = false;
			return;
		}
		const hasContent = !!this.inputElement?.value.trim() || this.pendingAttachments.length > 0;
		button.disabled = state.status === 'error' || !hasContent;
		button.classList.toggle('empty', !hasContent);
	}

	private openComposerFileSearch(): void {
		const input = this.inputElement;
		if (!input || input.disabled) {
			return;
		}
		this.openMentionPickerFromCommand();
	}

	private async improveComposerPrompt(button?: HTMLButtonElement): Promise<void> {
		const input = this.inputElement;
		if (!input || input.disabled) {
			return;
		}
		await this.improvePromptInput(input, this.taskCreationMode, button);
	}

	private async improvePromptInput(input: HTMLTextAreaElement, mode: MicroIDETaskCreationMode, button?: HTMLButtonElement): Promise<void> {
		if (this.improvingPrompt || input.disabled) {
			return;
		}

		const previousTitle = button?.title;
		if (input === this.inputElement) {
			this.syncPendingMentionContextsFromInput();
		}
		this.improvingPrompt = true;
		this.setImproveButtonRunning(button, true);
		try {
			const improved = await this.microIDEAgentService.improvePrompt(input.value, mode, this.getSendableFileContexts());
			input.value = improved;
			input.focus();
			input.setSelectionRange(input.value.length, input.value.length);
			if (input === this.inputElement) {
				this.syncPendingMentionContextsFromInput();
				this.updateCommandPalette();
				void this.updateMentionPalette();
				this.updateTurnButtonState();
				this.renderFileContexts();
			}
			if (this.taskStudioFileContextsElement) {
				this.renderStudioFileContexts(this.taskStudioFileContextsElement);
			}
			this.renderContextMeter(this.microIDEAgentService.getState());
		} catch (error) {
			this.notificationService.error(toErrorMessage(error));
		} finally {
			this.improvingPrompt = false;
			this.setImproveButtonRunning(button, false, previousTitle);
		}
	}

	private setImproveButtonRunning(button: HTMLButtonElement | undefined, running: boolean, previousTitle?: string): void {
		if (!button || !button.isConnected) {
			return;
		}
		const status = this.microIDEAgentService.getState().status;
		button.disabled = running || status === 'busy' || status === 'error';
		button.classList.toggle('running', running);
		button.title = running ? localize('microide.workbuddy.improvingPrompt', "Improving prompt...") : previousTitle ?? localize('microide.workbuddy.improvePrompt', "Improve prompt");
	}

	private renderContextMeter(state: IMicroIDEAgentState): void {
		const meter = this.contextMeterElement;
		if (!meter) {
			return;
		}
		const estimate = this.estimateAgentContextUsage(state);
		const rounded = Math.min(100, Math.max(0, Math.round(estimate.percent)));
		meter.style.setProperty('--microide-context-percent', `${rounded}%`);
		meter.setAttribute('aria-valuenow', String(rounded));
		meter.classList.toggle('warning', rounded >= 70 && rounded < 90);
		meter.classList.toggle('danger', rounded >= 90);
		meter.title = localize(
			'microide.contextMeterTitle',
			"Agent context used: {0}% ({1} / {2} tokens{3}). Counts this session's sent messages, tool I/O, sent attachments, and sent file context references; current draft and pending chips are not included.",
			rounded,
			formatCompactNumber(estimate.tokens),
			formatCompactNumber(estimate.windowTokens),
			estimate.windowEstimated ? localize('microide.contextWindowEstimated', ", estimated window") : ''
		);
		const core = meter.querySelector<HTMLElement>('.microide-context-meter-core');
		if (core) {
			core.textContent = rounded > 0 ? `${rounded}%` : '';
		}
	}

	private estimateAgentContextUsage(state: IMicroIDEAgentState): { readonly tokens: number; readonly windowTokens: number; readonly windowEstimated: boolean; readonly percent: number } {
		const activeSessionId = state.activeSessionId ?? state.session?.id ?? null;
		const messages = state.messages.filter(message => message.sessionId === activeSessionId && message.kind !== 'runReport');
		const historyChars = messages.reduce((sum, message) => sum + estimateMessageContextChars(message), 0);
		const attachmentTokens = messages.reduce((sum, message) => sum + (message.attachments?.length ?? 0) * IMAGE_ATTACHMENT_TOKEN_ESTIMATE, 0);
		const tokens = Math.ceil(historyChars / 4) + attachmentTokens;
		const window = resolveModelContextWindow(resolveSelectedModel(state));
		return {
			tokens,
			windowTokens: window.tokens,
			windowEstimated: window.estimated,
			percent: tokens / window.tokens * 100
		};
	}

	private renderAgentModeButton(state: IMicroIDEAgentState): void {
		const button = this.agentModeButton;
		if (!button) {
			return;
		}
		const selected = this.getAgentModeOption(state.agentMode);
		dom.reset(button);
		appendIcon(button, selected.icon);
		const label = dom.append(button, dom.$('span.microide-agent-mode-label'));
		label.textContent = selected.label;
		appendIcon(button, Codicon.chevronDown);
	}

	private toggleAgentModePopover(): void {
		const popover = this.agentModePopoverElement;
		if (!popover) {
			return;
		}
		const visible = !popover.classList.contains('visible');
		if (visible) {
			this.closeOtherPopovers('agentMode');
		}
		this.renderAgentModePopover(this.microIDEAgentService.getState(), visible);
	}

	private renderAgentModePopover(state: IMicroIDEAgentState, visible: boolean): void {
		const popover = this.agentModePopoverElement;
		if (!popover) {
			return;
		}

		dom.reset(popover);
		popover.classList.toggle('visible', visible);
		if (!visible) {
			return;
		}

		for (const option of AGENT_MODE_OPTIONS) {
			const row = dom.append(popover, dom.$('button.microide-agent-mode-option')) as HTMLButtonElement;
			row.type = 'button';
			row.classList.toggle('selected', option.id === state.agentMode);
			row.title = `${option.label} - ${option.description}`;
			appendIcon(row, option.icon);
			const body = dom.append(row, dom.$('.microide-agent-mode-option-body'));
			const name = dom.append(body, dom.$('.microide-agent-mode-option-name'));
			name.textContent = option.label;
			const description = dom.append(body, dom.$('.microide-agent-mode-option-description'));
			description.textContent = option.description;
			if (option.id === state.agentMode) {
				appendIcon(row, Codicon.check);
			}
			row.addEventListener('click', () => void this.selectAgentMode(option.id));
		}
	}

	private async selectAgentMode(mode: MicroIDEAgentMode): Promise<void> {
		this.agentModePopoverElement?.classList.remove('visible');
		this.agentModeButton?.setAttribute('aria-expanded', 'false');
		try {
			await this.microIDEAgentService.setAgentMode(mode);
		} catch (error) {
			this.notificationService.error(toErrorMessage(error));
		}
		this.renderAgentModeButton(this.microIDEAgentService.getState());
		this.inputElement?.focus();
	}

	private getAgentModeOption(mode: MicroIDEAgentMode): typeof AGENT_MODE_OPTIONS[number] {
		return AGENT_MODE_OPTIONS.find(option => option.id === mode) ?? AGENT_MODE_OPTIONS[0]!;
	}

	private renderModelButton(state: IMicroIDEAgentState): void {
		const button = this.modelButton;
		if (!button) {
			return;
		}
		dom.reset(button);
		const selected = resolveSelectedModel(state);
		appendIcon(button, Codicon.chip);
		const label = dom.append(button, dom.$('span.microide-model-button-label'));
		label.textContent = selected?.label || selected?.id || localize('microide.modelPending', "Model pending");
		if (typeof selected?.weight === 'number') {
			const weight = dom.append(button, dom.$('span.microide-model-button-weight'));
			weight.textContent = formatWeight(selected.weight);
		}
		appendIcon(button, Codicon.chevronDown);
	}

	private toggleModelPopover(state: IMicroIDEAgentState): void {
		const popover = this.modelPopoverElement;
		if (!popover) {
			return;
		}
		const visible = !popover.classList.contains('visible');
		if (visible) {
			this.closeOtherPopovers('model');
		}
		this.renderModelPopover(state, visible);
	}

	private renderModelPopover(state: IMicroIDEAgentState, visible: boolean): void {
		const popover = this.modelPopoverElement;
		if (!popover) {
			return;
		}

		dom.reset(popover);
		popover.classList.toggle('visible', visible);
		if (!visible) {
			return;
		}

		// Tab header �?switch between the model list and the custom-endpoint form, mirroring
		// the reference picker's 閺傜増膩�?/ 閼奉亜鐣炬稊?tabs.
		const tabs = dom.append(popover, dom.$('.microide-model-tabs'));
		const makeTab = (id: 'models' | 'custom', label: string): void => {
			const tab = dom.append(tabs, dom.$('button.microide-model-tab')) as HTMLButtonElement;
			tab.type = 'button';
			tab.textContent = label;
			tab.classList.toggle('active', this.modelPopoverTab === id);
			tab.addEventListener('click', () => {
				if (this.modelPopoverTab !== id) {
					this.modelPopoverTab = id;
					this.renderModelPopover(state, true);
				}
			});
		};
		makeTab('models', localize('microide.modelTabModels', "Models"));
		makeTab('custom', localize('microide.modelTabCustom', "Custom"));

		if (this.modelPopoverTab === 'custom') {
			this.renderCustomModelForm(popover, state);
			return;
		}

		const models = state.configuration?.models ?? [];
		const selectedId = resolveSelectedModel(state)?.id;
		const list = dom.append(popover, dom.$('.microide-model-list'));

		// Group by tier when the engine reports tiers; otherwise fall back to provider
		// grouping so long lists stay scannable (mirrors the reference model picker).
		const groups = groupModels(models);
		for (const group of groups) {
			if (group.label) {
				const heading = dom.append(list, dom.$('.microide-model-group-label'));
				heading.textContent = group.label;
			}
			for (const model of group.models) {
				const row = dom.append(list, dom.$('button.microide-model-option')) as HTMLButtonElement;
				row.type = 'button';
				row.classList.toggle('selected', model.id === selectedId);
				const body = dom.append(row, dom.$('.microide-model-option-body'));
				const name = dom.append(body, dom.$('.microide-model-option-name'));
				name.textContent = model.label || model.id;
				const host = formatHost(model.baseUrl) ?? model.provider;
				if (model.description || host) {
					const meta = dom.append(body, dom.$('.microide-model-option-meta'));
					meta.textContent = model.description ?? host ?? '';
				}
				if (typeof model.weight === 'number') {
					const weight = dom.append(row, dom.$('span.microide-model-option-weight'));
					weight.textContent = formatWeight(model.weight);
				}
				if (model.custom) {
					const remove = dom.append(row, dom.$('span.microide-model-option-remove')) as HTMLElement;
					remove.title = localize('microide.removeCustomModel', "Remove custom model");
					appendIcon(remove, Codicon.trash);
					remove.addEventListener('click', e => { e.stopPropagation(); void this.removeCustomModel(model.id); });
				} else if (model.id === selectedId) {
					appendIcon(row, Codicon.check);
				}
				row.addEventListener('click', () => void this.selectModel(model.id));
			}
		}

		if (!models.length) {
			const empty = dom.append(list, dom.$('.microide-model-empty'));
			empty.textContent = localize('microide.noModels', "No models configured");
		}
	}

	private renderCustomModelForm(popover: HTMLElement, state: IMicroIDEAgentState): void {
		const form = dom.append(popover, dom.$('.microide-model-form'));
		const makeField = (labelText: string, placeholder: string, type: 'text' | 'password' = 'text'): HTMLInputElement => {
			const field = dom.append(form, dom.$('.microide-model-field'));
			const label = dom.append(field, dom.$('label.microide-model-field-label'));
			label.textContent = labelText;
			const input = dom.append(field, dom.$(`input.microide-model-input`)) as HTMLInputElement;
			input.type = type;
			input.placeholder = placeholder;
			return input;
		};

		const idInput = makeField(localize('microide.customModelId', "Model ID"), localize('microide.customModelIdPlaceholder', "e.g. gpt-4o, claude-3-5-sonnet"));
		const labelInput = makeField(localize('microide.customModelLabel', "Display name"), localize('microide.customModelLabelPlaceholder', "Optional display name"));
		const baseUrlInput = makeField(localize('microide.customModelBaseUrl', "Base URL"), 'https://api.example.com');
		const apiKeyInput = makeField(localize('microide.customModelApiKey', "API Key"), localize('microide.customModelApiKeyPlaceholder', "Stored locally on this machine"), 'password');

		const actions = dom.append(form, dom.$('.microide-model-form-actions'));
		const save = dom.append(actions, dom.$('button.microide-button.primary.compact')) as HTMLButtonElement;
		save.type = 'button';
		const saveLabel = dom.append(save, dom.$('span.microide-button-label'));
		saveLabel.textContent = localize('microide.customModelSave', "Add and use");
		save.addEventListener('click', () => {
			const id = idInput.value.trim();
			if (!id) {
				idInput.focus();
				return;
			}
			void this.addCustomModel({
				id,
				label: labelInput.value.trim() || id,
				baseUrl: baseUrlInput.value.trim() || undefined,
				apiKey: apiKeyInput.value.trim() || undefined
			});
		});

		const hint = dom.append(form, dom.$('.microide-model-form-hint'));
		hint.textContent = localize('microide.customModelHint', "Base URL and API key are stored only on this machine for your custom model service.");
	}

	private async addCustomModel(model: { id: string; label: string; baseUrl?: string; apiKey?: string }): Promise<void> {
		try {
			await this.microIDEAgentService.addCustomModel(model);
			this.modelPopoverTab = 'models';
			this.modelPopoverElement?.classList.remove('visible');
		} catch (error) {
			this.notificationService.error(toErrorMessage(error));
		} finally {
			this.renderState();
		}
	}

	private async removeCustomModel(modelId: string): Promise<void> {
		try {
			await this.microIDEAgentService.removeCustomModel(modelId);
		} catch (error) {
			this.notificationService.error(toErrorMessage(error));
		} finally {
			this.renderModelPopover(this.microIDEAgentService.getState(), true);
		}
	}

	private togglePermissionPopover(state: IMicroIDEAgentState): void {
		const popover = this.permissionPopoverElement;
		if (!popover) {
			return;
		}

		const visible = !popover.classList.contains('visible');
		if (visible) {
			this.closeOtherPopovers('permission');
		}
		this.renderPermissionPopover(state, visible);
	}

	private renderPermissionPopover(state: IMicroIDEAgentState, visible: boolean): void {
		const popover = this.permissionPopoverElement;
		if (!popover) {
			return;
		}

		dom.reset(popover);
		popover.classList.toggle('visible', visible);
		if (!visible) {
			return;
		}

		const header = dom.append(popover, dom.$('.microide-permission-popover-header'));
		const title = dom.append(header, dom.$('span'));
		title.textContent = localize('microide.permissionModeQuestion', "How should microClaude actions be approved?");

		const modes: Array<{ mode: MicroIDEPermissionMode; icon: ThemeIcon; label: string; description: string }> = [
			{ mode: 'ask', icon: Codicon.lock, label: localize('microide.permissionModeAsk', "Ask every action"), description: localize('microide.permissionModeAskDescription', "Ask before reads, edits, commands, and risky tools.") },
			{ mode: 'auto', icon: Codicon.shield, label: localize('microide.permissionModeAuto', "Auto edits, ask commands"), description: localize('microide.permissionModeAutoDescription', "Approve safe reads and edits, then ask before command or risky tools.") },
			{ mode: 'fullAccess', icon: Codicon.warning, label: localize('microide.permissionModeFullAccess', "Full access"), description: localize('microide.permissionModeFullAccessDescription', "Run without permission prompts. Use only for trusted workspaces.") }
		];

		for (const option of modes) {
			const row = dom.append(popover, dom.$('button.microide-permission-mode-option')) as HTMLButtonElement;
			row.type = 'button';
			row.classList.toggle('selected', option.mode === state.permissionMode);
			row.classList.toggle('danger', option.mode === 'fullAccess');
			appendIcon(row, option.icon);
			const body = dom.append(row, dom.$('.microide-permission-mode-option-body'));
			const label = dom.append(body, dom.$('.microide-permission-mode-option-label'));
			label.textContent = option.label;
			const description = dom.append(body, dom.$('.microide-permission-mode-option-description'));
			description.textContent = option.description;
			if (option.mode === state.permissionMode) {
				appendIcon(row, Codicon.check);
			}
			row.addEventListener('click', () => void this.selectPermissionMode(option.mode));
		}
	}

	private async selectPermissionMode(mode: MicroIDEPermissionMode): Promise<void> {
		try {
			await this.microIDEAgentService.setPermissionMode(mode);
		} catch (error) {
			this.notificationService.error(toErrorMessage(error));
		} finally {
			this.permissionPopoverElement?.classList.remove('visible');
			this.renderState();
		}
	}

	private updateCommandPalette(): void {
		const input = this.inputElement;
		const palette = this.commandPaletteElement;
		if (!input || !palette) {
			return;
		}

		const value = input.value.trimStart();
		if (!value.startsWith('/')) {
			dom.reset(palette);
			palette.classList.remove('visible');
			return;
		}

		const query = value.slice(1).trim().toLowerCase();
		const state = this.microIDEAgentService.getState();
		const selectedModel = resolveSelectedModel(state);
		const currentEffort = resolveCurrentEffort(state);
		const fastModeEnabled = state.modelRuntime.fastModeState === 'on';

		dom.reset(palette);
		palette.classList.add('visible');
		this.closeOtherPopovers('command');
		let rendered = 0;
		const sections = new Set<string>();
		const ensureSection = (title: string): void => {
			if (sections.has(title)) {
				return;
			}
			sections.add(title);
			const label = dom.append(palette, dom.$('.microide-command-section'));
			label.textContent = title;
		};

		const actions: IMicroIDESlashAction[] = [
			{ section: localize('microide.slashSectionContext', "Context"), icon: Codicon.add, label: localize('microide.slashAttachFile', "Attach file..."), description: localize('microide.slashAttachFileDescription', "Open the workspace file picker"), action: 'attach-file' },
			{ section: localize('microide.slashSectionContext', "Context"), icon: Codicon.files, label: localize('microide.slashMentionFile', "Mention file from this project..."), description: localize('microide.slashMentionFileDescription', "Choose a file or folder with @"), action: 'mention-file' },
			{ section: localize('microide.slashSectionContext', "Context"), icon: Codicon.clearAll, label: localize('microide.slashClearConversation', "Clear conversation"), description: localize('microide.slashClearConversationDescription', "Clear the local panel transcript"), action: 'clear-conversation' },
			{ section: localize('microide.slashSectionContext', "Context"), icon: Codicon.history, label: localize('microide.slashRewind', "Rewind"), description: localize('microide.slashRewindDescription', "Ask microClaude to rewind the conversation"), value: '/rewind', action: 'insert-command' },
			{ section: localize('microide.slashSectionModel', "Model"), icon: Codicon.chip, label: localize('microide.slashSwitchModel', "Switch model..."), description: selectedModel?.id, value: selectedModel?.label ?? localize('microide.modelDefaultRecommended', "Default"), action: 'switch-model' },
			{ section: localize('microide.slashSectionModel', "Model"), icon: Codicon.lightbulb, label: localize('microide.slashThinking', "Thinking"), value: state.modelRuntime.thinkingEnabled ? localize('microide.toggleOn', "On") : localize('microide.toggleOff', "Off"), action: 'toggle-thinking' },
			{ section: localize('microide.slashSectionModel', "Model"), icon: Codicon.account, label: localize('microide.slashAccountUsage', "Account & usage..."), description: localize('microide.slashAccountUsageDescription', "Show usage and status through microClaude"), value: '/cost', action: 'account-usage' },
			{ section: localize('microide.slashSectionModel', "Model"), icon: Codicon.zap, label: localize('microide.slashFastMode', "Toggle fast mode"), value: fastModeEnabled ? localize('microide.toggleOn', "On") : localize('microide.toggleOff', "Off"), action: 'toggle-fast-mode' }
		];

		for (const action of actions) {
			if (!this.matchesSlashQuery(query, action.label, action.description, action.value)) {
				continue;
			}
			ensureSection(action.section);
			this.appendSlashActionRow(palette, action);
			rendered++;
		}

		if (this.matchesSlashQuery(query, 'effort', 'reasoning effort', effortLabel(currentEffort))) {
			ensureSection(localize('microide.slashSectionModel', "Model"));
			this.appendEffortControl(palette, state);
			rendered++;
		}

		const commandMatches = state.slashCommands
			.filter(item => this.matchesSlashQuery(query, slashCommandText(item), item.name, item.description, item.argumentHint))
			.slice(0, query ? 12 : 8);

		if (commandMatches.length) {
			ensureSection(localize('microide.slashSectionCommands', "Slash Commands"));
			for (const item of commandMatches) {
				const row = dom.append(palette, dom.$('button.microide-command-suggestion')) as HTMLButtonElement;
				row.type = 'button';
				const commandText = slashCommandText(item);
				row.title = [commandText, item.argumentHint, slashCommandDescription(item)].filter(Boolean).join(' - ');
				appendIcon(row, slashCommandIcon(item));
				const body = dom.append(row, dom.$('.microide-command-suggestion-body'));
				const name = dom.append(body, dom.$('.microide-command-suggestion-name'));
				name.textContent = commandText;
				const description = dom.append(body, dom.$('.microide-command-suggestion-description'));
				description.textContent = slashCommandDescription(item);
				if (item.argumentHint) {
					const value = dom.append(row, dom.$('.microide-command-suggestion-value'));
					value.textContent = item.argumentHint;
				}
				row.addEventListener('click', () => this.acceptCommandSuggestion(commandText));
				rendered++;
			}
		}

		if (!rendered) {
			const empty = dom.append(palette, dom.$('.microide-command-suggestion-empty'));
			empty.textContent = localize('microide.noCommandMatches', "No matching commands");
		}
	}

	private matchesSlashQuery(query: string, ...values: Array<string | undefined>): boolean {
		if (!query) {
			return true;
		}
		return values.some(value => value?.toLowerCase().includes(query));
	}

	private appendSlashActionRow(palette: HTMLElement, item: IMicroIDESlashAction): void {
		const row = dom.append(palette, dom.$('button.microide-command-suggestion')) as HTMLButtonElement;
		row.type = 'button';
		row.title = [item.label, item.description, item.value].filter(Boolean).join(' - ');
		appendIcon(row, item.icon);
		const body = dom.append(row, dom.$('.microide-command-suggestion-body'));
		const name = dom.append(body, dom.$('.microide-command-suggestion-name'));
		name.textContent = item.label;
		if (item.description) {
			const description = dom.append(body, dom.$('.microide-command-suggestion-description'));
			description.textContent = item.description;
		}
		if (item.value) {
			const value = dom.append(row, dom.$('.microide-command-suggestion-value'));
			value.textContent = item.value;
		}
		if (item.action === 'toggle-thinking') {
			this.appendCommandToggle(row, this.microIDEAgentService.getState().modelRuntime.thinkingEnabled);
		} else if (item.action === 'toggle-fast-mode') {
			this.appendCommandToggle(row, this.microIDEAgentService.getState().modelRuntime.fastModeState === 'on');
		}
		row.addEventListener('click', () => this.runSlashAction(item));
	}

	private appendCommandToggle(container: HTMLElement, enabled: boolean): void {
		const toggle = dom.append(container, dom.$('.microide-command-toggle'));
		toggle.classList.toggle('on', enabled);
		dom.append(toggle, dom.$('.microide-command-toggle-knob'));
	}

	private appendEffortControl(palette: HTMLElement, state: IMicroIDEAgentState): void {
		const row = dom.append(palette, dom.$('.microide-command-suggestion.microide-command-suggestion-control.microide-effort-control'));
		appendIcon(row, Codicon.rocket);
		const body = dom.append(row, dom.$('.microide-command-suggestion-body'));
		const name = dom.append(body, dom.$('.microide-command-suggestion-name'));
		const control = dom.append(row, dom.$('.microide-command-effort-control-body'));
		const slider = dom.append(control, dom.$('input.microide-command-effort-slider')) as HTMLInputElement;
		const value = dom.append(control, dom.$('span.microide-command-effort-value'));
		slider.type = 'range';
		slider.min = '0';
		slider.max = String(REASONING_EFFORTS.length - 1);
		slider.step = '1';
		slider.disabled = state.status === 'busy' || state.status === 'error';
		let effortIndex = Math.max(0, REASONING_EFFORTS.findIndex(effort => effort.id === resolveCurrentEffort(state)));
		slider.value = String(effortIndex);
		const updateControl = (): void => {
			const effort = REASONING_EFFORTS[effortIndex] ?? REASONING_EFFORTS[2];
			name.textContent = localize('microide.slashEffortWithValue', "Effort ({0})", effort.label);
			slider.title = effort.label;
			value.textContent = effort.label;
			const percent = REASONING_EFFORTS.length <= 1 ? 100 : effortIndex / (REASONING_EFFORTS.length - 1) * 100;
			slider.style.setProperty('--microide-effort-percent', `${percent}%`);
		};
		updateControl();
		slider.addEventListener('input', () => {
			effortIndex = Math.max(0, Math.min(REASONING_EFFORTS.length - 1, Number(slider.value) || 0));
			updateControl();
		});
		slider.addEventListener('change', () => {
			const effort = REASONING_EFFORTS[effortIndex]?.id;
			if (effort) {
				void this.setReasoningEffort(effort);
			}
		});
	}

	private runSlashAction(item: IMicroIDESlashAction): void {
		switch (item.action) {
			case 'attach-file':
			case 'mention-file':
				this.openMentionPickerFromCommand();
				return;
			case 'clear-conversation':
				this.microIDEAgentService.clearMessages();
				this.commandPaletteElement?.classList.remove('visible');
				this.inputElement?.focus();
				return;
			case 'switch-model':
				this.commandPaletteElement?.classList.remove('visible');
				this.renderModelPopover(this.microIDEAgentService.getState(), true);
				this.modelButton?.focus();
				return;
			case 'account-usage':
				this.acceptCommandSuggestion('/cost');
				return;
			case 'toggle-thinking':
				void this.toggleThinking();
				return;
			case 'toggle-fast-mode':
				this.acceptCommandSuggestion('/fast');
				return;
			case 'insert-command':
				this.acceptCommandSuggestion(item.value ?? '/help');
				return;
		}
	}

	private async toggleThinking(): Promise<void> {
		const enabled = this.microIDEAgentService.getState().modelRuntime.thinkingEnabled;
		try {
			await this.microIDEAgentService.setThinkingEnabled(!enabled);
		} catch (error) {
			this.notificationService.error(toErrorMessage(error));
		} finally {
			this.updateCommandPalette();
			this.renderState();
		}
	}

	private async setReasoningEffort(effort: MicroIDEEffortLevel): Promise<void> {
		try {
			await this.microIDEAgentService.setEffort(effort);
		} catch (error) {
			this.notificationService.error(toErrorMessage(error));
		} finally {
			this.updateCommandPalette();
			this.renderState();
		}
	}

	private acceptFirstCommandSuggestion(): void {
		this.commandPaletteElement?.querySelector<HTMLButtonElement>('button.microide-command-suggestion')?.click();
	}

	private acceptCommandSuggestion(command: string): void {
		if (!this.inputElement) {
			return;
		}

		this.inputElement.value = `${command} `;
		this.commandPaletteElement?.classList.remove('visible');
		this.updateTurnButtonState();
		this.inputElement.focus();
	}

	private openMentionPickerFromCommand(): void {
		const input = this.inputElement;
		if (!input) {
			return;
		}
		if (input.value.trimStart().startsWith('/')) {
			input.value = '@';
			input.setSelectionRange(1, 1);
			this.commandPaletteElement?.classList.remove('visible');
			input.focus();
			void this.updateMentionPalette();
			this.updateTurnButtonState();
			return;
		}
		const caret = input.selectionStart ?? input.value.length;
		const before = input.value.slice(0, caret);
		const after = input.value.slice(caret);
		const prefix = before && !/\s$/.test(before) ? ' @' : '@';
		input.value = `${before}${prefix}${after}`;
		const nextCaret = before.length + prefix.length;
		input.setSelectionRange(nextCaret, nextCaret);
		this.commandPaletteElement?.classList.remove('visible');
		input.focus();
		void this.updateMentionPalette();
		this.updateTurnButtonState();
	}

	private getActiveMentionQuery(): { query: string; start: number } | undefined {
		const input = this.inputElement;
		if (!input) {
			return undefined;
		}
		const caret = input.selectionStart ?? input.value.length;
		const head = input.value.slice(0, caret);
		const match = /(?:^|\s)@([^\s@]*)$/.exec(head);
		if (!match) {
			return undefined;
		}
		const query = match[1];
		return { query, start: caret - query.length - 1 };
	}

	private async updateMentionPalette(): Promise<void> {
		const palette = this.mentionPopoverElement;
		if (!palette) {
			return;
		}

		const active = this.getActiveMentionQuery();
		if (!active) {
			dom.reset(palette);
			palette.classList.remove('visible');
			return;
		}

		this.mentionSearchCts?.cancel();
		const cts = new CancellationTokenSource();
		this.mentionSearchCts = cts;

		try {
			const suggestions = await this.getMentionSuggestions(active.query, cts);
			if (cts.token.isCancellationRequested || this.mentionSearchCts !== cts) {
				return;
			}

			dom.reset(palette);
			if (!suggestions.length) {
				palette.classList.remove('visible');
				return;
			}
			palette.classList.add('visible');
			this.closeOtherPopovers('mention');
			this.mentionActiveIndex = 0;
			for (const suggestion of suggestions) {
				this.appendMentionSuggestion(palette, suggestion.path, active.start, undefined, suggestion.isDirectory ? 'directory' : 'file');
			}
			this.updateMentionSelection(0);
		} catch (error) {
			// Search failures should not break composing; just hide the palette.
			palette.classList.remove('visible');
		}
	}

	private async getMentionSuggestions(query: string, cts: CancellationTokenSource): Promise<IMicroIDEMentionSuggestion[]> {
		const folders = this.workspaceContextService.getWorkspace().folders;
		if (!folders.length) {
			return [];
		}
		if (!query) {
			return this.getWorkspaceRootMentionSuggestions();
		}

		const scoped = await this.resolveMentionScope(query);
		if (scoped) {
			const [directories, files] = await Promise.all([
				this.getDirectoryMentionSuggestions(scoped.directory, scoped.term),
				this.searchMentionFiles([scoped.directory], scoped.term, cts)
			]);
			return dedupeMentionSuggestions([...directories, ...files]).slice(0, 30);
		}

		const [directories, files] = await Promise.all([
			this.getWorkspaceRootMentionSuggestions(query),
			this.searchMentionFiles(folders, query, cts)
		]);
		return dedupeMentionSuggestions([...directories, ...files]).slice(0, 30);
	}

	private async resolveMentionScope(query: string): Promise<{ readonly directory: URI; readonly term: string } | undefined> {
		const normalized = query.replace(/\\/g, '/');
		const slash = normalized.lastIndexOf('/');
		if (slash < 0) {
			return undefined;
		}
		const directoryPath = normalized.slice(0, slash);
		const term = normalized.slice(slash + 1);
		const directory = this.resolvePathResource(directoryPath);
		if (!directory) {
			return undefined;
		}
		try {
			const stat = await this.fileService.resolve(directory);
			return stat.isDirectory ? { directory, term } : undefined;
		} catch {
			return undefined;
		}
	}

	private async searchMentionFiles(folders: Parameters<QueryBuilder['file']>[0], filePattern: string, cts: CancellationTokenSource): Promise<IMicroIDEMentionSuggestion[]> {
		if (!this.queryBuilder) {
			this.queryBuilder = this.instantiationService.createInstance(QueryBuilder);
		}
		const query = this.queryBuilder.file(folders, {
			filePattern: filePattern || undefined,
			maxResults: 24,
			sortByScore: true
		});
		const result = await this.searchService.fileSearch(query, cts.token);
		return result.results.slice(0, 24).map(fileMatch => ({
			path: this.toWorkspaceRelativePath(fileMatch.resource),
			isDirectory: false
		}));
	}

	private async getDirectoryMentionSuggestions(directory: URI, term: string): Promise<IMicroIDEMentionSuggestion[]> {
		const stat = await this.fileService.resolve(directory);
		const normalizedTerm = term.trim().toLowerCase();
		const suggestions: IMicroIDEMentionSuggestion[] = [];
		for (const child of stat.children ?? []) {
			if (!child.isDirectory) {
				continue;
			}
			const relative = this.toWorkspaceRelativePath(child.resource);
			if (!relative || (normalizedTerm && !fuzzyPathMatch(relative, normalizedTerm))) {
				continue;
			}
			suggestions.push({
				path: /[\\/]$/.test(relative) ? relative : `${relative}/`,
				isDirectory: true
			});
		}
		suggestions.sort((a, b) => a.path.localeCompare(b.path));
		return suggestions.slice(0, 12);
	}

	private async getWorkspaceRootMentionSuggestions(term = ''): Promise<IMicroIDEMentionSuggestion[]> {
		const folders = this.workspaceContextService.getWorkspace().folders;
		const stats = await Promise.all(folders.map(async folder => {
			try {
				return await this.fileService.resolve(folder.uri);
			} catch {
				return undefined;
			}
		}));
		const normalizedTerm = term.trim().toLowerCase();
		const suggestions: IMicroIDEMentionSuggestion[] = [];
		for (const stat of stats) {
			for (const child of stat?.children ?? []) {
				const relative = this.toWorkspaceRelativePath(child.resource);
				if (!relative || (normalizedTerm && !fuzzyPathMatch(relative, normalizedTerm))) {
					continue;
				}
				suggestions.push({
					path: child.isDirectory && !/[\\/]$/.test(relative) ? `${relative}/` : relative,
					isDirectory: child.isDirectory
				});
			}
		}
		suggestions.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.path.localeCompare(b.path));
		return suggestions.slice(0, 30);
	}

	private appendMentionSuggestion(palette: HTMLElement, relativePath: string, start: number, badge?: string, kind: 'file' | 'directory' = 'file'): void {
		const row = dom.append(palette, dom.$(`button.microide-mention-suggestion.${kind}`)) as HTMLButtonElement;
		row.type = 'button';
		row.title = relativePath;
		row.dataset.path = relativePath;
		row.dataset.kind = kind;
		row.dataset.start = String(start);
		appendIcon(row, kind === 'directory' ? Codicon.folder : Codicon.file);
		const body = dom.append(row, dom.$('.microide-mention-suggestion-body'));
		const name = dom.append(body, dom.$('.microide-mention-suggestion-name'));
		name.textContent = pathBasename(relativePath);
		const pathLabel = dom.append(body, dom.$('.microide-mention-suggestion-path'));
		pathLabel.textContent = badge ? `${badge} �?${relativePath}` : relativePath;
		row.addEventListener('mouseenter', () => {
			const rows = this.getMentionSuggestionRows();
			const index = rows.indexOf(row);
			if (index >= 0) {
				this.updateMentionSelection(index);
			}
		});
		row.addEventListener('click', () => this.acceptMentionSuggestion(relativePath, start, kind));
	}

	private acceptSelectedMentionSuggestion(): void {
		const rows = this.getMentionSuggestionRows();
		const row = rows[this.mentionActiveIndex] ?? rows[0];
		row?.click();
	}

	private moveMentionSelection(delta: number): void {
		const rows = this.getMentionSuggestionRows();
		if (!rows.length) {
			return;
		}
		const next = (this.mentionActiveIndex + delta + rows.length) % rows.length;
		this.updateMentionSelection(next);
		rows[next].scrollIntoView({ block: 'nearest' });
	}

	private updateMentionSelection(index: number): void {
		const rows = this.getMentionSuggestionRows();
		if (!rows.length) {
			this.mentionActiveIndex = 0;
			return;
		}
		this.mentionActiveIndex = Math.max(0, Math.min(rows.length - 1, index));
		rows.forEach((row, rowIndex) => {
			const selected = rowIndex === this.mentionActiveIndex;
			row.classList.toggle('selected', selected);
			row.setAttribute('aria-selected', String(selected));
		});
	}

	private getMentionSuggestionRows(): HTMLButtonElement[] {
		return [...this.mentionPopoverElement?.querySelectorAll<HTMLButtonElement>('button.microide-mention-suggestion') ?? []];
	}

	private toWorkspaceRelativePath(resource: URI): string {
		const folder = this.workspaceContextService.getWorkspaceFolder(resource);
		if (folder) {
			const folderPath = folder.uri.path;
			if (resource.path === folderPath) {
				return pathBasename(resource.path);
			}
			if (resource.path.startsWith(folderPath.endsWith('/') ? folderPath : `${folderPath}/`)) {
				return resource.path.slice(folderPath.length).replace(/^\/+/, '');
			}
		}
		return resource.fsPath;
	}

	private acceptMentionSuggestion(relativePath: string, start: number, kind: 'file' | 'directory' = 'file'): void {
		const input = this.inputElement;
		if (!input) {
			return;
		}
		const caret = input.selectionStart ?? input.value.length;
		const before = input.value.slice(0, start);
		const after = input.value.slice(caret);
		const mention = `@${kind === 'directory' ? ensureTrailingSlash(relativePath) : relativePath}`;
		const spacer = kind === 'file' && (after.length === 0 || !/^\s/.test(after)) ? ' ' : '';
		input.value = `${before}${mention}${spacer}${after}`;
		const newCaret = before.length + mention.length + spacer.length;
		input.setSelectionRange(newCaret, newCaret);
		if (kind === 'directory') {
			this.mentionActiveIndex = 0;
			input.focus();
			void this.updateMentionPalette();
			return;
		}
		this.addFileContext(relativePath, 'mention');
		this.mentionPopoverElement?.classList.remove('visible');
		this.updateTurnButtonState();
		input.focus();
	}

	private addFileContext(path: string, source: IMicroIDEFileContextAttachment['source']): void {
		const trimmed = path.trim();
		if (!trimmed) {
			return;
		}
		if (!this.pendingFileContexts.some(context => context.path === trimmed && context.source === source)) {
			this.pendingFileContexts.push({
				id: `file-context-${Date.now()}-${this.pendingFileContexts.length}`,
				label: pathBasename(trimmed),
				path: trimmed,
				source,
				enabled: true
			});
		}
		this.renderFileContexts();
	}

	private syncPendingMentionContextsFromInput(): void {
		const input = this.inputElement;
		if (!input) {
			return;
		}
		const mentions = extractMentionPaths(input.value);
		const next = this.pendingFileContexts.filter(context => context.source !== 'mention' || mentions.has(context.path));
		if (next.length !== this.pendingFileContexts.length) {
			this.pendingFileContexts = next;
			this.renderFileContexts();
		}
	}
}

registerAction2(class MicroIDEOpenBrowserPanelAction extends Action2 {
	constructor() {
		super({
			id: 'microide.workbench.openBrowserPanel',
			title: localize('microide.openTaskBrowserPanel', "Open Browser in Task Panel"),
			category: localize('microide.category', "MicroWorker"),
			icon: Codicon.browser
		});
	}

	run(): void {
		mainWindow.dispatchEvent(new CustomEvent('microide:openTaskSidePanel', { detail: { mode: 'browser' as MicroIDETaskSidePanel } }));
	}
});

registerAction2(class MicroIDEOpenChangesPanelAction extends Action2 {
	constructor() {
		super({
			id: 'microide.workbench.openChangesPanel',
			title: localize('microide.openTaskChangesPanel', "Open Changes in Task Panel"),
			category: localize('microide.category', "MicroWorker"),
			icon: Codicon.diffMultiple
		});
	}

	run(): void {
		mainWindow.dispatchEvent(new CustomEvent('microide:openTaskSidePanel', { detail: { mode: 'changes' as MicroIDETaskSidePanel } }));
	}
});

registerAction2(class MicroIDEClearAgentMessagesAction extends Action2 {
	constructor() {
		super({
			id: 'microide.agent.clearMessages',
			title: localize('microide.clearAgentMessages', "Clear Agent Messages"),
			category: localize('microide.category', "MicroWorker"),
			icon: Codicon.clearAll,
			menu: {
				id: MenuId.ViewTitle,
				group: 'navigation',
				when: ContextKeyExpr.equals('view', MICROIDE_AGENT_PANEL_VIEW_ID)
			}
		});
	}

	run(accessor: ServicesAccessor): void {
		accessor.get(IMicroIDEAgentService).clearMessages();
	}
});

registerAction2(class MicroIDERefreshAgentAction extends Action2 {
	constructor() {
		super({
			id: 'microide.agent.refresh',
			title: localize('microide.refreshAgent', "Refresh microClaude Status"),
			category: localize('microide.category', "MicroWorker"),
			icon: Codicon.refresh,
			menu: {
				id: MenuId.ViewTitle,
				group: 'navigation',
				when: ContextKeyExpr.equals('view', MICROIDE_AGENT_PANEL_VIEW_ID)
			}
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IMicroIDEAgentService).refreshCapabilities();
	}
});

registerAction2(class MicroIDEClearResolvedPermissionsAction extends Action2 {
	constructor() {
		super({
			id: 'microide.permissions.clearResolved',
			title: localize('microide.clearResolvedPermissions', "Clear Resolved Permissions"),
			category: localize('microide.category', "MicroWorker"),
			icon: Codicon.clearAll,
			menu: {
				id: MenuId.ViewTitle,
				group: 'navigation',
				when: ContextKeyExpr.equals('view', MICROIDE_AGENT_PANEL_VIEW_ID)
			}
		});
	}

	run(accessor: ServicesAccessor): void {
		accessor.get(IMicroIDEAgentService).clearResolvedPermissions();
	}
});

function isTurnRunning(state: IMicroIDEAgentState): boolean {
	const phase = state.turnStatus?.phase;
	return state.status === 'busy' || phase === 'sending' || phase === 'thinking' || phase === 'waitingPermission' || phase === 'runningTool' || phase === 'summarizing';
}

function getWorkBuddyTaskStatusPresentation(state: IMicroIDEAgentState): { readonly label: string; readonly icon: ThemeIcon; readonly state: 'thinking' | 'tools' | 'generating' | 'completed' | 'blocked' | 'error' } {
	const turn = state.turnStatus;
	if (turn) {
		switch (turn.phase) {
			case 'waitingPermission':
				return { label: localize('microide.workbuddy.statusApproval', "Waiting for approval"), icon: Codicon.lock, state: 'blocked' };
			case 'runningTool':
				return { label: localize('microide.workbuddy.statusCallingTools', "Calling tools"), icon: Codicon.tools, state: 'tools' };
			case 'summarizing':
				return { label: localize('microide.workbuddy.statusGeneratingResponse', "Generating response"), icon: Codicon.commentDiscussion, state: 'generating' };
			case 'done':
				return { label: localize('microide.workbuddy.statusCompleted', "Completed"), icon: Codicon.check, state: 'completed' };
			case 'error':
				return { label: localize('microide.workbuddy.statusFailed', "Failed"), icon: Codicon.error, state: 'error' };
			case 'interrupted':
				return { label: localize('microide.workbuddy.statusStopped', "Stopped"), icon: Codicon.debugStop, state: 'error' };
			case 'sending':
			case 'thinking':
			default:
				return { label: localize('microide.workbuddy.statusThinking', "Thinking"), icon: Codicon.sync, state: 'thinking' };
		}
	}
	if (state.status === 'busy' || state.status === 'starting') {
		return { label: localize('microide.workbuddy.statusThinking', "Thinking"), icon: Codicon.sync, state: 'thinking' };
	}
	if (state.status === 'error') {
		return { label: localize('microide.workbuddy.statusFailed', "Failed"), icon: Codicon.error, state: 'error' };
	}
	return { label: localize('microide.workbuddy.statusCompleted', "Completed"), icon: Codicon.check, state: 'completed' };
}

function renderStatus(container: HTMLElement, state: IMicroIDEAgentState): void {
	dom.reset(container);
	const status = dom.append(container, dom.$(`.microide-status-badge.${state.status}`));
	const turn = state.turnStatus;
	appendIcon(status, turn ? turnPhaseIcon(turn.phase) : state.status === 'busy' || state.status === 'starting' ? Codicon.sync : state.status === 'error' ? Codicon.error : Codicon.circleFilled);
	const label = dom.append(status, dom.$('span'));
	label.textContent = turn ? turnPhaseLabel(turn.phase) : statusLabel(state.status);

	if (turn) {
		const detail = dom.append(container, dom.$('.microide-status-detail'));
		const detailText = formatTurnStatusDetail(turn);
		detail.textContent = detailText;
		detail.title = detailText;
	}

	if (state.error) {
		const error = dom.append(container, dom.$('.microide-status-error'));
		error.textContent = state.error;
	}
}

function turnPhaseIcon(phase: MicroIDETurnPhase): ThemeIcon {
	switch (phase) {
		case 'waitingPermission':
			return Codicon.shield;
		case 'runningTool':
			return Codicon.tools;
		case 'done':
			return Codicon.check;
		case 'interrupted':
			return Codicon.stop;
		case 'error':
			return Codicon.error;
		default:
			return Codicon.sync;
	}
}

function turnPhaseLabel(phase: MicroIDETurnPhase): string {
	switch (phase) {
		case 'sending':
			return localize('microide.turnPreparing', "Preparing");
		case 'thinking':
			return localize('microide.turnDeepThinking', "Deep Thinking");
		case 'waitingPermission':
			return localize('microide.turnWaitingPermission', "Needs approval");
		case 'runningTool':
			return localize('microide.turnRunningTool', "Calling tools");
		case 'summarizing':
			return localize('microide.turnGenerating', "Generating");
		case 'done':
			return localize('microide.turnDone', "Completed");
		case 'interrupted':
			return localize('microide.turnInterrupted', "Stopped");
		case 'error':
			return localize('microide.turnError', "Failed");
	}
}

function formatTurnStatusDetail(turn: NonNullable<IMicroIDEAgentState['turnStatus']>): string {
	const parts = [formatElapsed(Date.now() - turn.startedAt)];
	if (turn.currentToolSummary) {
		parts.push(truncateSingleLine(turn.currentToolSummary, 56));
	} else if (turn.currentToolName) {
		parts.push(turn.currentToolName);
	}
	if (turn.pendingPermissionCount > 0) {
		parts.push(localize('microide.turnPendingPermissions', "{0} pending", turn.pendingPermissionCount));
	}
	return parts.join(' / ');
}

function formatElapsed(duration: number): string {
	const seconds = Math.max(0, Math.round(duration / 1000));
	if (seconds < 60) {
		return localize('microide.elapsedSeconds', "{0}s", seconds);
	}
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return rest ? localize('microide.elapsedMinutesSeconds', "{0}m {1}s", minutes, rest) : localize('microide.elapsedMinutes', "{0}m", minutes);
}

function formatSessionStats(session: IMicroIDEAgentSessionTab): string {
	const parts: string[] = [];
	if (session.toolCount) {
		parts.push(localize('microide.sessionStatsTools', "{0} tools", session.toolCount));
	}
	if (session.commandCount) {
		parts.push(localize('microide.sessionStatsCommands', "{0} commands", session.commandCount));
	}
	if (session.changedFileCount) {
		parts.push(localize('microide.sessionStatsFiles', "{0} files", session.changedFileCount));
	}
	if (session.permissionCount) {
		parts.push(localize('microide.sessionStatsPermissions', "{0} approvals", session.permissionCount));
	}
	return parts.join(' / ');
}

function formatSessionTabTitle(session: IMicroIDEAgentSessionTab): string {
	const parts = [sessionDisplayTitle(session)];
	const meta = [session.status, session.model].filter(Boolean).join(' / ');
	if (meta) {
		parts.push(meta);
	}
	return parts.join('\n');
}

function sessionDisplayTitle(session: IMicroIDEAgentSessionTab): string {
	if (session.customTitle?.trim()) {
		return session.customTitle.trim();
	}
	if (session.generatedTitle?.trim()) {
		return session.generatedTitle.trim();
	}
	if (session.summary?.trim()) {
		return truncateSingleLine(session.summary, 42);
	}
	const normalized = session.title?.trim();
	if (normalized && !/^untitled$/i.test(normalized) && normalized !== 'New session') {
		return normalized;
	}
	return localize('microide.untitledSession', "Untitled");
}

function sessionTabMeta(session: IMicroIDEAgentSessionTab): string {
	if (session.status === 'busy') {
		return localize('microide.sessionTabBusy', "Running");
	}
	return session.model ?? localize('microide.sessionTabReady', "Ready");
}

function pathBasename(value: string): string {
	const normalized = value.replace(/[\\/]+$/, '');
	const index = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
	return index >= 0 ? normalized.slice(index + 1) : normalized;
}

function ensureTrailingSlash(value: string): string {
	return /[\\/]$/.test(value) ? value : `${value}/`;
}

function fileSearchDisplayName(value: string, isDirectory: boolean): string {
	const normalized = value.replace(/[\\/]+$/, '');
	const basename = pathBasename(normalized) || normalized || value;
	return isDirectory && !basename.endsWith('/') ? `${basename}/` : basename;
}

function fileSearchParentPath(value: string): string {
	const normalized = value.replace(/[\\/]+$/, '');
	const index = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
	return index > 0 ? normalized.slice(0, index + 1) : '';
}

function extractMentionPaths(value: string): Set<string> {
	const paths = new Set<string>();
	const mentionPattern = /(?:^|\s)@([^\s@]+)/g;
	let match: RegExpExecArray | null;
	while ((match = mentionPattern.exec(value))) {
		const path = match[1]?.trim();
		if (path && !/[\\/]$/.test(path)) {
			paths.add(path);
		}
	}
	return paths;
}

function fuzzyPathMatch(path: string, query: string): boolean {
	const haystack = path.toLowerCase();
	if (haystack.includes(query)) {
		return true;
	}
	let index = 0;
	for (const char of query) {
		index = haystack.indexOf(char, index);
		if (index < 0) {
			return false;
		}
		index++;
	}
	return true;
}

function dedupeMentionSuggestions(suggestions: readonly IMicroIDEMentionSuggestion[]): IMicroIDEMentionSuggestion[] {
	const seen = new Set<string>();
	const result: IMicroIDEMentionSuggestion[] = [];
	for (const suggestion of suggestions) {
		const key = `${suggestion.isDirectory ? 'd' : 'f'}:${suggestion.path}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		result.push(suggestion);
	}
	return result;
}

function formatSelectedLines(count: number): string {
	return count === 1
		? localize('microide.selectedLineSingle', "1 line selected")
		: localize('microide.selectedLineCount', "{0} lines selected", count);
}

function formatCompactNumber(value: number): string {
	if (value >= 1_000_000) {
		return `${(value / 1_000_000).toFixed(1)}M`;
	}
	if (value >= 1_000) {
		return `${Math.round(value / 100) / 10}K`;
	}
	return String(value);
}

interface ITranscriptRendererHost {
	readonly markdownRendererService: IMarkdownRendererService;
	copyText(text: string): Promise<void>;
	openPath(path: string): void;
	openDiff(diff: IMicroIDEDiffPreview): void;
}

interface IRenderedTranscriptItem {
	message: IMicroIDEAgentMessage;
	readonly root: HTMLElement;
	signature: string;
	readonly disposables: DisposableStore;
}

/**
 * Renders the conversation timeline with keyed, incremental reconciliation: each message keeps
 * its DOM node across state updates and is only re-rendered when its content signature changes.
 * This avoids rebuilding the entire transcript (and re-parsing markdown) on every 16ms tick during
 * streaming. Completed assistant text is rendered as markdown; streaming text stays plain for speed.
 */
class TranscriptRenderer extends Disposable {
	private timelineElement: HTMLElement | undefined;
	private turnStatusElement: HTMLElement | undefined;
	private turnStatusSignature = '';
	private readonly items = new Map<string, IRenderedTranscriptItem>();
	private readonly toolOpenState = new Map<string, boolean>();
	private readonly diffOpenState = new Map<string, boolean>();

	constructor(
		private readonly container: HTMLElement,
		private readonly host: ITranscriptRendererHost
	) {
		super();
		this._register({ dispose: () => this.clear() });
	}

	clear(): void {
		for (const item of this.items.values()) {
			item.disposables.dispose();
		}
		this.items.clear();
		this.timelineElement = undefined;
		this.turnStatusElement = undefined;
		this.turnStatusSignature = '';
		dom.reset(this.container);
	}

	render(state: IMicroIDEAgentState): void {
		if (!this.timelineElement) {
			dom.reset(this.container);
			this.items.clear();
			this.timelineElement = dom.append(this.container, dom.$('.microide-timeline'));
		}

		const timeline = this.timelineElement;
		const seen = new Set<string>();
		const visibleMessages = state.messages.filter(message => message.kind !== 'runReport');
		let cursor: ChildNode | null = timeline.firstChild;

		for (const message of visibleMessages) {
			seen.add(message.id);
			let item = this.items.get(message.id);
			const signature = this.signatureOf(message);
			if (!item) {
				item = { message, root: dom.$(`.microide-timeline-item.${message.role}.${message.state}`), signature: '', disposables: new DisposableStore() };
				this.items.set(message.id, item);
				this.renderItem(item, message);
				item.signature = signature;
			} else if (item.signature !== signature) {
				this.renderItem(item, message);
				item.message = message;
				item.signature = signature;
			} else {
				item.message = message;
			}

			if (cursor === item.root) {
				cursor = cursor.nextSibling;
			} else {
				timeline.insertBefore(item.root, cursor);
			}
		}

		for (const [id, item] of this.items) {
			if (!seen.has(id)) {
				item.disposables.dispose();
				item.root.remove();
				this.items.delete(id);
			}
		}
		this.renderTurnStatus(timeline, cursor, state);
	}

	private renderTurnStatus(timeline: HTMLElement, cursor: ChildNode | null, state: IMicroIDEAgentState): void {
		const turnStatus = state.turnStatus;
		if (!turnStatus || turnStatus.phase === 'done' || turnStatus.phase === 'interrupted' || turnStatus.phase === 'error') {
			this.turnStatusElement?.remove();
			this.turnStatusElement = undefined;
			this.turnStatusSignature = '';
			return;
		}

		const signature = [
			turnStatus.phase,
			turnStatus.currentToolName ?? '',
			turnStatus.currentToolSummary ?? '',
			turnStatus.pendingPermissionCount
		].join('|');
		if (!this.turnStatusElement) {
			this.turnStatusElement = dom.$('.microide-timeline-item.status.streaming') as HTMLElement;
		}
		if (this.turnStatusSignature !== signature) {
			this.turnStatusSignature = signature;
			dom.clearNode(this.turnStatusElement);
			const marker = dom.append(this.turnStatusElement, dom.$('.microide-timeline-marker'));
			appendIcon(marker, turnStatusIcon(turnStatus.phase));
			const content = dom.append(this.turnStatusElement, dom.$('.microide-timeline-content'));
			const item = dom.append(content, dom.$(`.microide-turn-status-inline.phase-${turnStatus.phase}`));
			const label = dom.append(item, dom.$('.microide-turn-status-label'));
			label.textContent = turnStatusLabel(turnStatus);
			if (turnStatus.currentToolSummary && turnStatus.phase !== 'waitingPermission') {
				const summary = dom.append(item, dom.$('.microide-turn-status-summary'));
				summary.textContent = turnStatus.currentToolSummary;
			}
		}
		if (cursor !== this.turnStatusElement) {
			timeline.insertBefore(this.turnStatusElement, cursor);
		}
	}

	// __TRANSCRIPT_RENDERER_PART2__
	private signatureOf(message: IMicroIDEAgentMessage): string {
		// Capture every field that affects the rendered output so unchanged messages are skipped.
		const diffSig = message.diff ? `${message.diff.filePath}:${message.diff.added}:${message.diff.removed}:${message.diff.hunks.length}` : '';
		const outLen = typeof message.output === 'string' ? message.output.length : message.output ? 1 : 0;
		const fileContextSig = message.fileContexts?.map(context => `${context.source}:${context.path}:${context.label}:${context.enabled ? 1 : 0}:${context.selectionLineCount ?? 0}:${context.selectionRanges?.map(range => `${range.startLineNumber}-${range.endLineNumber}`).join(';') ?? ''}`).join(',') ?? '';
		return [message.role, message.kind ?? '', message.state, message.text.length, message.text.slice(-64), message.toolName ?? '', message.toolEffect ?? '', message.summary ?? '', message.command ?? '', message.path ?? '', message.isError ? 1 : 0, outLen, diffSig, message.attachments?.length ?? 0, fileContextSig].join('|');
	}

	private renderItem(item: IRenderedTranscriptItem, message: IMicroIDEAgentMessage): void {
		item.disposables.clear();
		dom.clearNode(item.root);
		item.root.className = `microide-timeline-item ${message.role} ${message.state}`;

		const marker = dom.append(item.root, dom.$('.microide-timeline-marker'));
		appendIcon(marker, timelineIcon(message));
		const content = dom.append(item.root, dom.$('.microide-timeline-content'));

		if (message.role === 'tool') {
			this.renderToolMessage(content, message, item.disposables);
		} else {
			this.renderConversationMessage(content, message, item.disposables);
		}
	}

	private renderConversationMessage(container: HTMLElement, message: IMicroIDEAgentMessage, store: DisposableStore): void {
		if (message.kind === 'runReport') {
			this.renderRunReportMessage(container, message);
			return;
		}

		const item = dom.append(container, dom.$(`.microide-message.${message.role}.${message.state}`));
		const meta = dom.append(item, dom.$('.microide-message-meta'));
		meta.textContent = `${messageRoleLabel(message.role)} / ${formatTime(message.createdAt)}`;
		this.appendCopyButton(item, () => messageCopyText(message), store, localize('microide.copyMessage', "Copy message"));
		const body = dom.append(item, dom.$('.microide-message-body'));

		// Render assistant prose as markdown once it is complete (code blocks get syntax
		// highlighting + links become clickable); keep streaming text plain for throughput.
		const text = message.text || (message.state === 'streaming' ? localize('microide.streaming', "Thinking") : '');
		if (message.role === 'user') {
			this.renderUserMessageBody(body, message, text, store);
		} else if (message.role === 'assistant' && message.state === 'complete' && message.text.trim()) {
			body.classList.add('markdown');
			const rendered = store.add(this.host.markdownRendererService.render(new MarkdownString(message.text, { isTrusted: false, supportThemeIcons: true }), {}));
			body.appendChild(rendered.element);
			this.decorateMarkdownCodeBlocks(body, store);
		} else {
			body.textContent = text;
		}

		if (message.attachments?.length) {
			const gallery = dom.append(item, dom.$('.microide-message-attachments'));
			for (const attachment of message.attachments) {
				const thumb = dom.append(gallery, dom.$('img.microide-message-attachment')) as HTMLImageElement;
				thumb.src = `data:${attachment.mediaType};base64,${attachment.data}`;
				thumb.alt = attachment.name;
				thumb.title = attachment.name;
			}
		}
	}

	private renderUserMessageBody(body: HTMLElement, message: IMicroIDEAgentMessage, text: string, store: DisposableStore): void {
		const contexts = (message.fileContexts ?? []).filter(context => context.enabled);
		const activeContexts = contexts.filter(context => context.source === 'activeEditor');
		const mentionContexts = contexts.filter(context => context.source === 'mention');

		if (activeContexts.length) {
			const row = dom.append(body, dom.$('.microide-message-contexts.active-editor'));
			for (const context of activeContexts) {
				this.appendMessageFileChip(row, context, 'active-editor', store);
			}
		}

		if (mentionContexts.length) {
			const line = dom.append(body, dom.$('.microide-message-user-line'));
			for (const context of mentionContexts) {
				this.appendMessageFileChip(line, context, 'mention', store);
			}
			const content = dom.append(line, dom.$('span.microide-message-user-text'));
			content.textContent = text;
			return;
		}

		const content = dom.append(body, dom.$('span.microide-message-user-text'));
		content.textContent = text;
	}

	private appendMessageFileChip(container: HTMLElement, context: IMicroIDEFileContextAttachment, kind: 'active-editor' | 'mention', store: DisposableStore): void {
		const chip = dom.append(container, dom.$(`button.microide-message-file-chip.${kind}`)) as HTMLButtonElement;
		chip.type = 'button';
		chip.title = context.path;
		appendIcon(chip, Codicon.file);
		const label = dom.append(chip, dom.$('span'));
		label.textContent = kind === 'mention' ? `@${context.path}` : context.label;
		store.add(dom.addDisposableListener(chip, 'click', () => this.host.openPath(context.path)));
	}

	private appendCopyButton(container: HTMLElement, getText: () => string, store: DisposableStore, label: string): HTMLButtonElement {
		const button = dom.append(container, dom.$('button.microide-copy-button')) as HTMLButtonElement;
		button.type = 'button';
		button.title = label;
		button.setAttribute('aria-label', label);
		appendIcon(button, Codicon.copy);
		store.add(dom.addDisposableListener(button, 'click', event => {
			event.preventDefault();
			event.stopPropagation();
			const text = getText();
			if (!text) {
				return;
			}
			void this.host.copyText(text).then(() => {
				button.classList.add('copied');
				button.title = localize('microide.copied', "Copied");
				button.setAttribute('aria-label', localize('microide.copied', "Copied"));
				dom.clearNode(button);
				appendIcon(button, Codicon.check);
				setTimeout(() => {
					if (!button.isConnected) {
						return;
					}
					button.classList.remove('copied');
					button.title = label;
					button.setAttribute('aria-label', label);
					dom.clearNode(button);
					appendIcon(button, Codicon.copy);
				}, 1400);
			});
		}));
		return button;
	}

	private decorateMarkdownCodeBlocks(body: HTMLElement, store: DisposableStore): void {
		for (const pre of Array.from(body.querySelectorAll('pre'))) {
			if (!(pre instanceof HTMLElement) || pre.querySelector('.microide-copy-button')) {
				continue;
			}
			pre.classList.add('microide-code-block');
			this.appendCopyButton(pre, () => (pre.querySelector('code')?.textContent ?? pre.innerText).trimEnd(), store, localize('microide.copyCodeBlock', "Copy code"));
		}
	}

	private renderRunReportMessage(container: HTMLElement, message: IMicroIDEAgentMessage): void {
		const item = dom.append(container, dom.$('.microide-run-report'));
		const header = dom.append(item, dom.$('.microide-run-report-header'));
		appendIcon(header, Codicon.graphLine);
		const title = dom.append(header, dom.$('.microide-run-report-title'));
		const lines = message.text.split(/\r?\n/).filter(line => line.trim().length > 0);
		title.textContent = lines[0] || localize('microide.runReportFallbackTitle', "Run report");
		const time = dom.append(header, dom.$('.microide-run-report-time'));
		time.textContent = formatTime(message.createdAt);

		const rows = dom.append(item, dom.$('.microide-run-report-rows'));
		for (const line of lines.slice(1)) {
			const separator = line.indexOf(':');
			const row = dom.append(rows, dom.$('.microide-run-report-row'));
			if (separator > 0) {
				const label = dom.append(row, dom.$('.microide-run-report-row-label'));
				label.textContent = line.slice(0, separator);
				const value = dom.append(row, dom.$('.microide-run-report-row-value'));
				value.textContent = line.slice(separator + 1).trim();
			} else {
				row.textContent = line;
			}
		}
	}

	private renderToolMessage(container: HTMLElement, message: IMicroIDEAgentMessage, store: DisposableStore): void {
		const card = dom.append(container, dom.$(`.microide-tool-card.${message.state}`));
		card.classList.add(`effect-${message.toolEffect ?? 'other'}`);
		card.classList.add(`display-${toolDisplayMode(message)}`);
		if (isTeamToolMessage(message)) {
			card.classList.add('team-tool');
		}
		const openKey = message.toolUseId ?? message.id;
		const storedOpen = this.toolOpenState.get(openKey);
		const isOpen = storedOpen ?? shouldAutoOpenTool(message);
		card.classList.toggle('open', isOpen);

		const summary = dom.append(card, dom.$('button.microide-tool-summary')) as HTMLButtonElement;
		summary.type = 'button';
		summary.title = localize('microide.toolToggleDetails', "Toggle tool details");
		summary.setAttribute('aria-expanded', String(isOpen));
		const stateDot = dom.append(summary, dom.$(`.microide-tool-state-dot.${message.state}`));
		stateDot.title = toolStateLabel(message);

		const title = dom.append(summary, dom.$('.microide-tool-title'));
		const primaryPath = toolPrimaryPath(message);
		if (primaryPath) {
			const verb = dom.append(title, dom.$('span.microide-tool-title-verb'));
			verb.textContent = `${formatToolActionLabel(message)} `;
			this.appendPathLink(title, primaryPath, store, { basename: false, className: 'microide-tool-title-path' });
		} else {
			title.textContent = formatToolTitle(message);
		}

		const meta = dom.append(summary, dom.$('.microide-tool-meta'));
		meta.textContent = formatToolInlineMeta(message);

		const attribution = formatToolAttribution(message);
		if (attribution) {
			const badge = dom.append(summary, dom.$('.microide-tool-attribution'));
			appendIcon(badge, attribution.icon);
			const text = dom.append(badge, dom.$('span'));
			text.textContent = attribution.label;
			badge.title = attribution.title;
		}

		const chevron = dom.append(summary, dom.$('.microide-tool-chevron'));
		appendIcon(chevron, Codicon.chevronRight);
		store.add(dom.addDisposableListener(summary, 'click', () => {
			const nextOpen = !card.classList.contains('open');
			card.classList.toggle('open', nextOpen);
			summary.setAttribute('aria-expanded', String(nextOpen));
			this.toolOpenState.set(openKey, nextOpen);
			const existingBody = card.querySelector<HTMLElement>('.microide-tool-body');
			if (nextOpen && !existingBody) {
				this.renderToolBody(card, message, store);
			} else if (!nextOpen) {
				existingBody?.remove();
			}
		}));

		if (message.diff) {
			this.renderDiffPreview(card, message.diff, store, { stateKey: `tool:${openKey}`, compact: true });
		}

		if (isOpen) {
			this.renderToolBody(card, message, store);
		}
	}

	private renderToolBody(container: HTMLElement, message: IMicroIDEAgentMessage, store: DisposableStore): void {
		const body = dom.append(container, dom.$('.microide-tool-body'));
		const mode = toolDisplayMode(message);
		if (mode === 'command') {
			this.renderCommandToolBody(body, message, store);
			this.renderToolRawDetails(body, message, store, { includeOutput: true });
			return;
		}
		if (message.diff) {
			this.renderToolRawDetails(body, message, store, { includeOutput: true });
			return;
		}
		if (mode === 'file') {
			this.renderFileToolBody(body, message, store);
			this.renderToolRawDetails(body, message, store, { includeOutput: true });
			return;
		}
		this.renderToolChannel(body, localize('microide.toolInput', "IN"), message.input, store);
		if (message.isError) {
			const friendly = formatToolErrorValue(message.output);
			this.renderToolChannel(body, localize('microide.toolError', "Error"), friendly, store, 'error');
		} else {
			this.renderToolChannel(body, localize('microide.toolOutput', "OUT"), message.output ?? (message.state === 'streaming' ? localize('microide.toolWaiting', "Waiting for result") : undefined), store);
		}
	}

	private renderCommandToolBody(container: HTMLElement, message: IMicroIDEAgentMessage, store: DisposableStore): void {
		const command = message.command ?? extractCommandText(message.input) ?? message.summary ?? message.toolName ?? '';
		const card = dom.append(container, dom.$(`.microide-tool-command-card.microide-tool-io-card${message.isError ? '.error' : ''}`));

		const input = dom.append(card, dom.$('.microide-tool-io-section'));
		const inputLabel = dom.append(input, dom.$('.microide-tool-io-label'));
		inputLabel.textContent = localize('microide.toolInput', "IN");
		const commandLine = dom.append(input, dom.$('pre.microide-tool-command-line'));
		commandLine.textContent = command;
		this.appendCopyButton(input, () => command, store, localize('microide.copyToolInput', "Copy input"));

		const output = getCommandDisplayOutput(message);
		if (output || message.state === 'streaming') {
			const outputBox = dom.append(card, dom.$(`.microide-tool-io-section.out${message.isError ? '.error' : ''}`));
			const outputLabel = dom.append(outputBox, dom.$('.microide-tool-io-label'));
			outputLabel.textContent = message.isError ? localize('microide.toolError', "Error") : localize('microide.toolOutput', "OUT");
			this.renderExpandableText(outputBox, output ?? localize('microide.commandToolWaiting', "Waiting for command output..."), store, {
				className: 'microide-tool-command-output-content',
				maxChars: 6000,
				maxLines: 80,
				linkify: true
			});
		}
	}

	private renderFileToolBody(container: HTMLElement, message: IMicroIDEAgentMessage, store: DisposableStore): void {
		const path = toolPrimaryPath(message);
		if (!path) {
			return;
		}

		const output = getFileDisplayOutput(message);
		if (output || message.state === 'streaming') {
			const preview = dom.append(container, dom.$(`.microide-tool-file-preview.microide-tool-io-card${message.isError ? '.error' : ''}`));
			const label = dom.append(preview, dom.$('.microide-tool-io-label'));
			label.textContent = message.isError ? localize('microide.toolError', "Error") : outputLineCount(output) ?? formatToolInlineMeta(message);
			this.renderExpandableText(preview, output ?? localize('microide.fileToolWaiting', "Waiting for file result..."), store, {
				className: 'microide-tool-file-preview-content',
				maxChars: 6000,
				maxLines: 80,
				linkify: true
			});
		}
	}

	private renderToolRawDetails(container: HTMLElement, message: IMicroIDEAgentMessage, store: DisposableStore, options: { readonly includeOutput: boolean }): void {
		const hasInput = message.input !== undefined && message.input !== null && message.input !== '';
		const hasOutput = options.includeOutput && message.output !== undefined && message.output !== null && message.output !== '';
		if (!hasInput && !hasOutput) {
			return;
		}

		const details = dom.append(container, dom.$('details.microide-tool-raw-details')) as HTMLDetailsElement;
		const summary = dom.append(details, dom.$('summary.microide-tool-raw-summary'));
		appendIcon(summary, Codicon.chevronRight);
		const text = dom.append(summary, dom.$('span'));
		text.textContent = localize('microide.toolExpandDetails', "Show raw IN / OUT");
		if (hasInput) {
			this.renderToolChannel(details, localize('microide.toolInput', "IN"), message.input, store);
		}
		if (hasOutput) {
			this.renderToolChannel(details, message.isError ? localize('microide.toolError', "Error") : localize('microide.toolOutput', "OUT"), message.output, store, message.isError ? 'error' : undefined);
		}
	}

	private renderExpandableText(container: HTMLElement, text: string, store: DisposableStore, options: { readonly className: string; readonly maxChars: number; readonly maxLines: number; readonly linkify?: boolean }): void {
		const preview = createTextPreview(text, options.maxChars, options.maxLines);
		const content = dom.append(container, dom.$(`pre.${options.className}`));
		const renderText = (value: string): void => {
			dom.clearNode(content);
			if (options.linkify) {
				this.appendLinkifiedText(content, value, store);
			} else {
				content.textContent = value;
			}
		};
		renderText(preview.text);
		this.appendCopyButton(container, () => text, store, localize('microide.copyToolOutput', "Copy output"));

		if (!preview.truncated) {
			return;
		}

		const expand = dom.append(container, dom.$('button.microide-tool-expand')) as HTMLButtonElement;
		expand.type = 'button';
		expand.textContent = localize('microide.toolOutputExpand', "Click to expand ({0} lines)", preview.totalLines);
		store.add(dom.addDisposableListener(expand, 'click', () => {
			renderText(text);
			expand.remove();
		}));
	}

	private renderToolChannel(container: HTMLElement, label: string, value: unknown, store: DisposableStore, kind?: 'error'): void {
		if (value === undefined || value === null || value === '') {
			return;
		}
		const channel = dom.append(container, dom.$(`.microide-tool-channel.microide-tool-io-card${kind === 'error' ? '.error' : ''}`));
		const header = dom.append(channel, dom.$('.microide-tool-io-label'));
		header.textContent = label;
		const content = dom.append(channel, dom.$('pre.microide-tool-channel-content'));
		const text = typeof value === 'string' ? value : formatToolValue(value);
		// Linkify file paths / `path:line` references so generated text opens in a normal editor.
		if (kind !== 'error') {
			this.appendLinkifiedText(content, text, store);
		} else {
			content.textContent = text;
		}
		this.appendCopyButton(channel, () => text, store, localize('microide.copyToolChannel', "Copy {0}", label));
	}

	renderDiffPreview(container: HTMLElement, diff: IMicroIDEDiffPreview, store: DisposableStore, options: { readonly stateKey?: string; readonly compact?: boolean } = {}): void {
		const preview = dom.append(container, dom.$('.microide-diff'));
		const totalLines = diff.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
		const stateKey = options.stateKey ?? diff.filePath;
		const previewStore = store.add(new DisposableStore());
		const render = (): void => {
			previewStore.clear();
			dom.clearNode(preview);
			const expanded = options.compact ? (this.diffOpenState.get(stateKey) ?? false) : true;
			preview.className = `microide-diff ${expanded ? 'expanded' : 'compact'}`;

			if (!expanded) {
				const compact = dom.append(preview, dom.$('.microide-diff-compact-preview'));
				compact.tabIndex = 0;
				compact.setAttribute('role', 'button');
				compact.title = localize('microide.diffClickToExpand', "Click to expand");
				const head = dom.append(compact, dom.$('.microide-diff-compact-head'));
				const title = dom.append(head, dom.$('.microide-diff-title'));
				appendIcon(title, Codicon.diff);
				this.appendPathLink(title, diff.filePath, previewStore, { basename: false });
				const stats = dom.append(head, dom.$('.microide-diff-stats'));
				stats.textContent = diff.summary;
				const lines = dom.append(compact, dom.$('.microide-diff-compact-lines'));
				this.renderDiffLines(lines, diff, 4);
				const hint = dom.append(compact, dom.$('.microide-diff-compact-hint'));
				hint.textContent = localize('microide.diffClickToExpand', "Click to expand");
				const expand = (): void => {
					this.diffOpenState.set(stateKey, true);
					render();
				};
				previewStore.add(dom.addDisposableListener(compact, 'click', () => expand()));
				previewStore.add(dom.addDisposableListener(compact, 'keydown', event => {
					if (event.key === 'Enter' || event.key === ' ') {
						event.preventDefault();
						expand();
					}
				}));
				return;
			}

			const header = dom.append(preview, dom.$('.microide-diff-header'));
			const title = dom.append(header, dom.$('.microide-diff-title'));
			appendIcon(title, Codicon.diff);
			this.appendPathLink(title, diff.filePath, previewStore, { basename: false });
			const stats = dom.append(header, dom.$('.microide-diff-stats'));
			stats.textContent = diff.summary;
			const actions = dom.append(header, dom.$('.microide-diff-actions'));
			const openButton = dom.append(actions, dom.$('button.microide-diff-open')) as HTMLButtonElement;
			openButton.type = 'button';
			openButton.title = localize('microide.openDiffEditor', "Open in editor");
			appendIcon(openButton, Codicon.goToFile);
			previewStore.add(dom.addDisposableListener(openButton, 'click', e => { e.stopPropagation(); this.host.openDiff(diff); }));
			if (options.compact) {
				const closeButton = dom.append(actions, dom.$('button.microide-diff-open')) as HTMLButtonElement;
				closeButton.type = 'button';
				closeButton.title = localize('microide.collapseDiff', "Collapse diff");
				appendIcon(closeButton, Codicon.close);
				previewStore.add(dom.addDisposableListener(closeButton, 'click', e => {
					e.stopPropagation();
					this.diffOpenState.set(stateKey, false);
					render();
				}));
			}

			const linesContainer = dom.append(preview, dom.$('.microide-diff-lines'));
			this.renderDiffLines(linesContainer, diff, 600);
			if (totalLines > 600) {
				const truncated = dom.append(preview, dom.$('.microide-diff-expand'));
				truncated.textContent = localize('microide.diffLargeOpenEditor', "Large diff truncated. Open in editor to inspect every line.");
			}
		};
		render();
	}

	private renderDiffLines(container: HTMLElement, diff: IMicroIDEDiffPreview, limit: number): number {
		let rendered = 0;
		for (const hunk of diff.hunks) {
			const hunkHeader = dom.append(container, dom.$('.microide-diff-hunk'));
			hunkHeader.textContent = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
			for (const line of hunk.lines) {
				if (rendered >= limit) {
					const truncated = dom.append(container, dom.$('.microide-diff-truncated'));
					truncated.textContent = localize('microide.diffTruncated', "Diff preview truncated");
					return rendered;
				}
				const row = dom.append(container, dom.$(`.microide-diff-line.${line.kind}`));
				const oldLine = dom.append(row, dom.$('span.microide-diff-line-number'));
				oldLine.textContent = line.oldLine === undefined ? '' : String(line.oldLine);
				const newLine = dom.append(row, dom.$('span.microide-diff-line-number'));
				newLine.textContent = line.newLine === undefined ? '' : String(line.newLine);
				const marker = dom.append(row, dom.$('span.microide-diff-marker'));
				marker.textContent = line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' ';
				const code = dom.append(row, dom.$('span.microide-diff-code'));
				code.textContent = line.text;
				rendered++;
			}
		}
		return rendered;
	}

	private appendPathLink(container: HTMLElement, path: string, store: DisposableStore, options: { readonly basename?: boolean; readonly className?: string } = {}): void {
		const link = dom.append(container, dom.$(`a.microide-path-link${options.className ? `.${options.className}` : ''}`)) as HTMLAnchorElement;
		link.textContent = options.basename === true ? basenameLike(path) : path;
		link.title = path;
		link.setAttribute('role', 'button');
		store.add(dom.addDisposableListener(link, 'click', e => { e.preventDefault(); e.stopPropagation(); this.host.openPath(path); }));
	}

	private appendLinkifiedText(container: HTMLElement, text: string, store: DisposableStore): void {
		// Bounded scan: only linkify when the output is small enough that scanning is cheap.
		PATH_LIKE_RE.lastIndex = 0;
		if (text.length > 20000 || !PATH_LIKE_RE.test(text)) {
			container.textContent = text;
			return;
		}
		PATH_LIKE_RE.lastIndex = 0;
		let lastIndex = 0;
		let match: RegExpExecArray | null;
		const doc = container.ownerDocument;
		while ((match = PATH_LIKE_RE.exec(text))) {
			const start = match.index;
			if (start > lastIndex) {
				container.appendChild(doc.createTextNode(text.slice(lastIndex, start)));
			}
			const raw = match[0];
			const link = dom.$('a.microide-path-link') as HTMLAnchorElement;
			link.textContent = raw;
			link.title = localize('microide.openPath', "Open {0}", raw);
			link.setAttribute('role', 'button');
			const target = raw;
			store.add(dom.addDisposableListener(link, 'click', e => { e.preventDefault(); e.stopPropagation(); this.host.openPath(target.replace(/:\d+(?::\d+)?$/, '')); }));
			container.appendChild(link);
			lastIndex = start + raw.length;
		}
		if (lastIndex < text.length) {
			container.appendChild(doc.createTextNode(text.slice(lastIndex)));
		}
	}
}

// Matches absolute Windows/POSIX paths and workspace-relative paths with a known source extension,
// optionally trailed by :line or :line:col. Kept deliberately conservative to avoid false positives.
const PATH_LIKE_RE = /(?:[a-zA-Z]:\\[^\s"'`<>|]+|\/[^\s"'`<>|]+|(?:[\w.-]+[\\/])+[\w.-]+\.[a-zA-Z]{1,8})(?::\d+(?::\d+)?)?/g;

function slashCommandText(command: IMicroClaudeSlashCommand): string {
	return `/${command.name.replace(/^\//, '').trim()}`;
}

function slashCommandDescription(command: IMicroClaudeSlashCommand): string {
	const name = command.name.replace(/^\//, '').trim().toLowerCase();
	if (name.includes('config')) {
		return localize('microide.slashConfigShortDescription', "Update or inspect MicroWorker config.");
	}
	return command.description;
}
function slashCommandIcon(command: IMicroClaudeSlashCommand): ThemeIcon {
	const name = command.name.replace(/^\//, '').toLowerCase();
	if (name.includes('review') || name.includes('security')) {
		return Codicon.shield;
	}
	if (name === 'init' || name.includes('verify') || name.includes('goal')) {
		return Codicon.checklist;
	}
	if (name.includes('compact') || name.includes('reload')) {
		return Codicon.sync;
	}
	if (name.includes('usage') || name.includes('insights') || name.includes('cost')) {
		return Codicon.graphLine;
	}
	if (name.includes('context') || name.includes('memory')) {
		return Codicon.book;
	}
	if (name.includes('clear')) {
		return Codicon.clearAll;
	}
	return Codicon.terminal;
}

function timelineIcon(message: IMicroIDEAgentMessage): ThemeIcon {
	if (message.role === 'user') {
		return Codicon.account;
	}
	if (message.role === 'tool') {
		return toolIcon(message);
	}
	if (message.kind === 'runReport') {
		return Codicon.graphLine;
	}
	if (message.state === 'error') {
		return Codicon.error;
	}
	return message.state === 'streaming' ? Codicon.sync : Codicon.agent;
}

function turnStatusIcon(phase: MicroIDETurnPhase): ThemeIcon {
	switch (phase) {
		case 'waitingPermission':
			return Codicon.lock;
		case 'runningTool':
			return Codicon.tools;
		case 'summarizing':
			return Codicon.commentDiscussion;
		case 'sending':
		case 'thinking':
			return Codicon.sync;
		default:
			return Codicon.agent;
	}
}

function turnStatusLabel(status: IMicroIDETurnStatus): string {
	switch (status.phase) {
		case 'sending':
			return localize('microide.turnStatusPreparing', "Preparing for execution");
		case 'thinking':
			return localize('microide.turnStatusDeepThinking', "Deep Thinking");
		case 'runningTool':
			return status.currentToolName
				? localize('microide.turnStatusCallingTool', "Calling {0}", status.currentToolName)
				: localize('microide.turnStatusCallingTools', "Calling tools");
		case 'waitingPermission':
			return status.pendingPermissionCount > 1
				? localize('microide.turnStatusWaitingPermissions', "Waiting for {0} approvals", status.pendingPermissionCount)
				: localize('microide.turnStatusWaitingPermission', "Waiting for approval");
		case 'summarizing':
			return localize('microide.turnStatusGenerating', "Generating response");
		default:
			return '';
	}
}

function toolIcon(message: IMicroIDEAgentMessage): ThemeIcon {
	if (message.toolEffect) {
		return toolEffectIcon(message.toolEffect);
	}
	const name = (message.toolName ?? '').toLowerCase();
	if (isAskUserQuestionToolName(message.toolName)) {
		return Codicon.comment;
	}
	if (message.diff || name.includes('edit') || name.includes('write') || name.includes('create')) {
		return Codicon.diff;
	}
	if (name.includes('bash') || name.includes('shell') || name.includes('powershell')) {
		return Codicon.terminal;
	}
	if (name.includes('read') || name.includes('file')) {
		return Codicon.file;
	}
	return Codicon.tools;
}

function toolEffectIcon(effect: MicroIDEToolEffect | undefined): ThemeIcon {
	switch (effect) {
		case 'read':
			return Codicon.file;
		case 'edit':
			return Codicon.diff;
		case 'command':
			return Codicon.terminal;
		case 'network':
			return Codicon.browser;
		case 'memory':
			return Codicon.book;
		default:
			return Codicon.tools;
	}
}

function formatToolTitle(message: IMicroIDEAgentMessage): string {
	const toolName = message.toolName ?? messageRoleLabel('tool');
	const askUserInput = parseAskUserQuestionInput(message.input);
	if (isAskUserQuestionToolName(toolName) && askUserInput) {
		return askUserQuestionToolTitle(askUserInput);
	}
	const path = toolPrimaryPath(message);
	if (path) {
		return `${formatToolActionLabel(message)} ${basenameLike(path)}`;
	}
	if (message.command) {
		return `${localize('microide.uiToolVerbRun', "Run")} ${truncateSingleLine(message.command, 60)}`;
	}
	return toolName;
}

function shouldAutoOpenTool(message: IMicroIDEAgentMessage): boolean {
	return message.state === 'error' || Boolean(message.isError);
}

function formatToolInlineMeta(message: IMicroIDEAgentMessage): string {
	const askUserInput = parseAskUserQuestionInput(message.input);
	if (isAskUserQuestionToolName(message.toolName) && askUserInput) {
		const answeredInput = parseAskUserQuestionInput(message.output) ?? parseAskUserQuestionInput(asObjectRecord(message.output)?.['data']);
		const answerCount = Object.keys(answeredInput?.answers ?? askUserInput.answers ?? {}).length;
		if (answerCount > 0) {
			return answerCount === 1
				? localize('microide.askUserQuestionOneAnswer', "1 answer")
				: localize('microide.askUserQuestionManyAnswers', "{0} answers", answerCount);
		}
		return localize('microide.askUserQuestionNeedsAnswer', "Needs answer");
	}
	if (message.state === 'streaming') {
		return localize('microide.toolRunning', "Running");
	}
	if (message.state === 'error' || message.isError) {
		return localize('microide.toolError', "Error");
	}
	if (message.diff) {
		return message.diff.summary;
	}
	const output = toolDisplayMode(message) === 'command' ? getCommandDisplayOutput(message) : getFileDisplayOutput(message);
	const lineCount = outputLineCount(output);
	if (lineCount) {
		return lineCount;
	}
	if (message.summary && message.summary !== message.toolName) {
		return truncateSingleLine(message.summary, 72);
	}
	return toolStateLabel(message);
}

function outputLineCount(text: string | undefined): string | undefined {
	if (!text) {
		return undefined;
	}
	const lines = countLines(text);
	return lines === 1
		? localize('microide.toolOneLine', "1 line")
		: localize('microide.toolManyLines', "{0} lines", lines);
}

function toolDisplayMode(message: IMicroIDEAgentMessage): 'command' | 'file' | 'generic' {
	if (message.toolEffect === 'command' || message.command || extractCommandText(message.input)) {
		return 'command';
	}
	if (toolPrimaryPath(message)) {
		return 'file';
	}
	return 'generic';
}

function isTeamToolMessage(message: IMicroIDEAgentMessage): boolean {
	return Boolean(message.teamName || message.agentId || message.agentName || isTeamToolName(message.toolName));
}

function formatToolAttribution(message: IMicroIDEAgentMessage): { readonly icon: ThemeIcon; readonly label: string; readonly title: string } | undefined {
	const input = asObjectRecord(message.input);
	const output = extractObjectRecord(message.output);
	const toolName = message.toolName ?? '';
	if (!isTeamToolName(toolName) && !message.teamName && !message.agentName && !message.agentId) {
		return undefined;
	}

	if (toolName === 'Agent') {
		const label = message.agentName
			?? getObjectString(output, 'name')
			?? getObjectString(input, 'name')
			?? getObjectString(input, 'subagent_type')
			?? localize('microide.teamToolAgent', "agent");
		const title = [
			localize('microide.teamToolAttributionAgent', "Agent"),
			message.agentId ?? getObjectString(output, 'agent_id') ?? getObjectString(output, 'agentId'),
			message.teamName
		].filter(Boolean).join(' / ');
		return { icon: Codicon.account, label, title };
	}

	if (toolName === 'TeamCreate' || toolName === 'TeamDelete') {
		const label = message.teamName
			?? getObjectString(output, 'team_name')
			?? getObjectString(output, 'teamName')
			?? getObjectString(input, 'team_name')
			?? localize('microide.teamToolTeam', "team");
		return { icon: Codicon.organization, label, title: localize('microide.teamToolAttributionTeam', "Team: {0}", label) };
	}

	if (toolName === 'SendMessage') {
		const label = message.agentName
			?? message.agentId
			?? getObjectString(input, 'to')
			?? getObjectString(output, 'target')
			?? localize('microide.teamToolMessage', "teammate");
		return { icon: Codicon.send, label, title: localize('microide.teamToolAttributionMessage', "Message to {0}", label) };
	}

	if (toolName.startsWith('Task')) {
		const label = getObjectString(input, 'owner')
			?? getObjectString(output, 'owner')
			?? getObjectString(input, 'task_id')
			?? getObjectString(input, 'taskId')
			?? localize('microide.teamToolTask', "team task");
		return { icon: Codicon.checklist, label, title: localize('microide.teamToolAttributionTask', "Team task: {0}", label) };
	}

	if (message.agentName || message.agentId) {
		const label = message.agentName ?? message.agentId!;
		return { icon: Codicon.account, label, title: [label, message.teamName].filter(Boolean).join(' / ') };
	}

	if (message.teamName) {
		return { icon: Codicon.organization, label: message.teamName, title: localize('microide.teamToolAttributionTeam', "Team: {0}", message.teamName) };
	}

	return undefined;
}

function isTeamToolName(toolName: string | undefined): boolean {
	return Boolean(toolName && ['TeamCreate', 'TeamDelete', 'Agent', 'SendMessage', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'].includes(toolName));
}

function messageCopyText(message: IMicroIDEAgentMessage): string {
	const parts: string[] = [];
	const text = message.text.trim();
	if (text) {
		parts.push(text);
	}
	const contexts = message.fileContexts?.filter(context => context.enabled);
	if (contexts?.length) {
		parts.push([
			'Context:',
			...contexts.map(context => `- ${context.path}${context.selectionLineCount ? ` (${formatSelectedLines(context.selectionLineCount)})` : ''}`)
		].join('\n'));
	}
	if (message.attachments?.length) {
		parts.push([
			'Attachments:',
			...message.attachments.map(attachment => `- ${attachment.name}`)
		].join('\n'));
	}
	if (message.role === 'tool') {
		if (message.input !== undefined && message.input !== null && message.input !== '') {
			parts.push(`IN:\n${typeof message.input === 'string' ? message.input : formatToolValue(message.input)}`);
		}
		if (message.output !== undefined && message.output !== null && message.output !== '') {
			parts.push(`${message.isError ? 'ERROR' : 'OUT'}:\n${typeof message.output === 'string' ? message.output : formatToolValue(message.output)}`);
		}
	}
	return parts.join('\n\n').trim();
}

function toolPrimaryPath(message: IMicroIDEAgentMessage): string | undefined {
	return message.path ?? message.diff?.filePath;
}

function formatToolActionLabel(message: IMicroIDEAgentMessage): string {
	const toolName = message.toolName ?? '';
	const lower = toolName.toLowerCase();
	if (message.diff?.isNewFile || lower.includes('create')) {
		return localize('microide.uiToolVerbCreate', "Create");
	}
	if (message.diff || message.toolEffect === 'edit') {
		return toolVerbLabel(toolName) || localize('microide.uiToolVerbEdit', "Edit");
	}
	if (message.toolEffect === 'read' || lower.includes('read') || lower.includes('grep') || lower.includes('glob') || lower.includes('list')) {
		return localize('microide.uiToolVerbRead', "Read");
	}
	return toolName || localize('microide.uiToolVerbOpen', "Open");
}

function getCommandDisplayOutput(message: IMicroIDEAgentMessage): string | undefined {
	if (message.isError) {
		return formatToolErrorValue(message.output);
	}
	const stdout = extractDisplayText(message.output, ['stdout', 'output']);
	const stderr = extractDisplayText(message.output, ['stderr']);
	if (stdout && stderr && stdout !== stderr) {
		return `${stdout.trimEnd()}\n\nstderr:\n${stderr}`;
	}
	return stdout ?? stderr ?? extractDisplayText(message.output, ['content', 'message', 'text']) ?? (message.output !== undefined ? formatToolValue(message.output) : undefined);
}

function getFileDisplayOutput(message: IMicroIDEAgentMessage): string | undefined {
	if (message.isError) {
		return formatToolErrorValue(message.output);
	}
	return extractDisplayText(message.output, ['content', 'text', 'stdout', 'output', 'message'])
		?? (message.output !== undefined ? formatToolValue(message.output) : undefined);
}

function extractCommandText(value: unknown): string | undefined {
	return extractDisplayText(value, ['command', 'cmd', 'script']);
}

function toolStateLabel(message: IMicroIDEAgentMessage): string {
	if (message.state === 'streaming') {
		return localize('microide.toolRunning', "Running");
	}
	if (message.state === 'error' || message.isError) {
		return localize('microide.toolError', "Error");
	}
	return localize('microide.toolDone', "Done");
}

function toolVerbLabel(toolName: string): string {
	const lower = toolName.toLowerCase();
	if (lower.includes('create')) {
		return localize('microide.uiToolVerbCreate', "Create");
	}
	if (lower.includes('write')) {
		return localize('microide.uiToolVerbWrite', "Write");
	}
	if (lower.includes('edit')) {
		return localize('microide.uiToolVerbEdit', "Edit");
	}
	if (lower.includes('read')) {
		return localize('microide.uiToolVerbRead', "Read");
	}
	return toolName;
}

function basenameLike(path: string): string {
	const normalized = path.replace(/\\/g, '/');
	const parts = normalized.split('/');
	return parts[parts.length - 1] || path;
}

function formatToolValue(value: unknown): string {
	if (typeof value === 'string') {
		return truncateMultiline(value, 12000);
	}
	try {
		return truncateMultiline(JSON.stringify(value, null, 2), 12000);
	} catch {
		return String(value);
	}
}

function extractDisplayText(value: unknown, preferredKeys: readonly string[], depth = 0): string | undefined {
	if (value === undefined || value === null || depth > 5) {
		return undefined;
	}
	if (typeof value === 'string') {
		return value;
	}
	if (Array.isArray(value)) {
		const parts: string[] = [];
		for (const item of value) {
			const text = extractDisplayText(item, preferredKeys, depth + 1);
			if (text) {
				parts.push(text);
			}
		}
		return parts.length ? parts.join('\n') : undefined;
	}
	if (typeof value !== 'object') {
		return undefined;
	}

	const record = value as Record<string, unknown>;
	for (const key of preferredKeys) {
		const direct = record[key];
		if (typeof direct === 'string' && direct.trim()) {
			return direct;
		}
	}

	const nested = record['data'] ?? record['result'] ?? record['toolUseResult'] ?? record['tool_use_result'];
	const nestedText = nested !== value ? extractDisplayText(nested, preferredKeys, depth + 1) : undefined;
	if (nestedText) {
		return nestedText;
	}

	const content = record['content'];
	if (typeof content === 'string') {
		return content;
	}
	if (Array.isArray(content)) {
		const parts = content
			.map(item => extractDisplayText(item, preferredKeys, depth + 1) ?? extractDisplayText(item, ['text', 'content'], depth + 1))
			.filter((text): text is string => Boolean(text));
		return parts.length ? parts.join('\n') : undefined;
	}

	return undefined;
}

function createTextPreview(text: string, maxChars: number, maxLines: number): { readonly text: string; readonly truncated: boolean; readonly totalLines: number } {
	const totalLines = countLines(text);
	let lineBreaks = 0;
	let lineLimitIndex = text.length;
	for (let index = 0; index < text.length; index++) {
		if (text.charCodeAt(index) === 10) {
			lineBreaks++;
			if (lineBreaks >= maxLines) {
				lineLimitIndex = index;
				break;
			}
		}
	}

	const limit = Math.min(text.length, maxChars, lineLimitIndex);
	const truncated = limit < text.length;
	return {
		text: truncated ? `${text.slice(0, Math.max(0, limit)).trimEnd()}\n...` : text,
		truncated,
		totalLines
	};
}

function countLines(text: string): number {
	if (!text) {
		return 0;
	}
	let lines = 1;
	for (let index = 0; index < text.length; index++) {
		if (text.charCodeAt(index) === 10) {
			lines++;
		}
	}
	return lines;
}

function estimateMessageContextChars(message: IMicroIDEAgentMessage): number {
	let chars = message.text.length
		+ (message.summary?.length ?? 0)
		+ (message.path?.length ?? 0)
		+ (message.command?.length ?? 0);

	chars += estimateUnknownValueChars(message.input, 32000);
	chars += estimateUnknownValueChars(message.output, 120000);

	if (message.diff) {
		chars += message.diff.filePath.length + message.diff.summary.length;
		for (const hunk of message.diff.hunks) {
			chars += 32;
			for (const line of hunk.lines) {
				chars += line.text.length + 8;
			}
		}
	}

	if (message.fileContexts?.length) {
		for (const context of message.fileContexts) {
			if (!context.enabled) {
				continue;
			}
			chars += context.path.length + context.label.length + 96;
			if (context.selectionRanges?.length) {
				chars += context.selectionRanges.length * 18;
			}
		}
	}

	return chars;
}

function estimateUnknownValueChars(value: unknown, maxChars: number): number {
	if (value === undefined || value === null || maxChars <= 0) {
		return 0;
	}

	const seen = new WeakSet<object>();
	const visit = (node: unknown, budget: number, depth: number): number => {
		if (budget <= 0 || node === undefined || node === null) {
			return 0;
		}
		if (typeof node === 'string') {
			return Math.min(node.length, budget);
		}
		if (typeof node === 'number' || typeof node === 'boolean') {
			return Math.min(String(node).length, budget);
		}
		if (typeof node !== 'object') {
			return 0;
		}
		if (seen.has(node)) {
			return 0;
		}
		if (depth > 6) {
			return Math.min(32, budget);
		}

		seen.add(node);
		let used = Array.isArray(node) ? 2 : 4;
		if (Array.isArray(node)) {
			for (const item of node) {
				used += visit(item, budget - used, depth + 1) + 1;
				if (used >= budget) {
					break;
				}
			}
			return Math.min(used, budget);
		}

		for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
			used += key.length + 2 + visit(child, budget - used, depth + 1);
			if (used >= budget) {
				break;
			}
		}
		return Math.min(used, budget);
	};

	return visit(value, maxChars, 0);
}

/**
 * Produce a human-readable error string from a tool failure result. Tool errors often
 * arrive as raw structured payloads (e.g. zod validation unions); rather than dumping the
 * JSON, extract any embedded `message` fields and present them as concise bullet lines.
 * Falls back to the formatted value when no messages can be extracted.
 */
function formatToolErrorValue(value: unknown): string {
	if (value === undefined || value === null || value === '') {
		return localize('microide.toolErrorUnknown', "The tool reported an error.");
	}

	// A leading "Error: ..." string may carry a JSON tail; try to parse and summarize it.
	let payload: unknown = value;
	if (typeof value === 'string') {
		const trimmed = value.trim();
		const jsonStart = trimmed.search(/[[{]/);
		if (jsonStart >= 0) {
			try {
				payload = JSON.parse(trimmed.slice(jsonStart));
			} catch {
				return truncateMultiline(trimmed, 4000);
			}
		} else {
			return truncateMultiline(trimmed, 4000);
		}
	}

	const messages: string[] = [];
	const visit = (node: unknown, depth: number): void => {
		if (depth > 6 || node === null || typeof node !== 'object') {
			return;
		}
		if (Array.isArray(node)) {
			for (const item of node) {
				visit(item, depth + 1);
			}
			return;
		}
		const record = node as Record<string, unknown>;
		const message = record['message'];
		if (typeof message === 'string' && message.trim()) {
			const path = Array.isArray(record['path']) ? (record['path'] as unknown[]).join('.') : undefined;
			messages.push(path ? `${path}: ${message}` : message);
		}
		for (const key of Object.keys(record)) {
			if (key !== 'message') {
				visit(record[key], depth + 1);
			}
		}
	};
	visit(payload, 0);

	if (messages.length === 0) {
		return formatToolValue(payload);
	}

	// De-duplicate while preserving order.
	const unique = [...new Set(messages)];
	return unique.map(line => `�?${line}`).join('\n');
}

function truncateSingleLine(value: string, maxLength: number): string {
	const singleLine = value.replace(/\s+/g, ' ').trim();
	return singleLine.length > maxLength ? `${singleLine.slice(0, maxLength - 3)}...` : singleLine;
}

function truncateMultiline(value: string, maxLength: number): string {
	return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function resolveSelectedModel(state: IMicroIDEAgentState): IMicroClaudeModelConfiguration | undefined {
	const models = state.configuration?.models ?? [];
	const selectedId = state.selectedModel ?? state.configuration?.selectedModel ?? state.configuration?.defaultModel ?? models[0]?.id;
	if (!selectedId) {
		return undefined;
	}
	return models.find(model => model.id === selectedId) ?? (models.length ? models[0] : { id: selectedId, label: selectedId });
}

function resolveCurrentEffort(state: IMicroIDEAgentState): MicroIDEEffortLevel {
	return REASONING_EFFORTS.some(effort => effort.id === state.modelRuntime.effort) ? state.modelRuntime.effort : 'high';
}

function effortLabel(effort: MicroIDEEffortLevel): string {
	return REASONING_EFFORTS.find(candidate => candidate.id === effort)?.label ?? effort;
}

function resolveModelContextWindow(model: IMicroClaudeModelConfiguration | undefined): { readonly tokens: number; readonly estimated: boolean } {
	const record = model as unknown as Record<string, unknown> | undefined;
	const explicit = firstPositiveInteger(
		record?.contextWindow,
		record?.contextWindowTokens,
		record?.maxContextTokens,
		record?.maxInputTokens
	);
	if (explicit) {
		return { tokens: explicit, estimated: false };
	}

	const hinted = parseContextWindowHint([model?.id, model?.label, model?.description].filter(Boolean).join(' '));
	if (hinted) {
		return { tokens: hinted, estimated: true };
	}

	return { tokens: DEFAULT_CONTEXT_WINDOW_TOKENS, estimated: true };
}

function firstPositiveInteger(...values: readonly unknown[]): number | undefined {
	for (const value of values) {
		if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
			return Math.round(value);
		}
	}
	return undefined;
}

function parseContextWindowHint(value: string): number | undefined {
	if (!value) {
		return undefined;
	}

	const patterns = [
		/(?:context|ctx|window)[^\d]{0,16}(\d+(?:\.\d+)?)\s*([kKmM])\b/,
		/(\d+(?:\.\d+)?)\s*([kKmM])\s*(?:context|ctx|tokens?|token window)\b/,
		/(\d{4,})\s*(?:tokens?|context|ctx)\b/i
	];

	for (const pattern of patterns) {
		const match = pattern.exec(value);
		if (!match) {
			continue;
		}
		const parsed = Number(match[1]);
		if (!Number.isFinite(parsed) || parsed <= 0) {
			continue;
		}
		const suffix = match[2]?.toLowerCase();
		if (suffix === 'm') {
			return Math.round(parsed * 1_000_000);
		}
		if (suffix === 'k') {
			return Math.round(parsed * 1_000);
		}
		if (parsed >= 4096) {
			return Math.round(parsed);
		}
	}

	return undefined;
}

interface IModelGroup {
	readonly label: string | undefined;
	readonly models: readonly IMicroClaudeModelConfiguration[];
}

function groupModels(models: readonly IMicroClaudeModelConfiguration[]): IModelGroup[] {
	if (!models.length) {
		return [];
	}
	// Prefer tier grouping (matches the reference picker's 閺嬩浇鍤?閹嗗厴/缂佸繑绁?sections); fall back to
	// provider; otherwise present a single flat group.
	const keyOf = (model: IMicroClaudeModelConfiguration): string | undefined => model.tier ?? model.provider;
	const hasGroups = models.some(model => keyOf(model));
	if (!hasGroups) {
		return [{ label: undefined, models }];
	}

	const order: string[] = [];
	const buckets = new Map<string, IMicroClaudeModelConfiguration[]>();
	for (const model of models) {
		const key = keyOf(model) ?? '';
		if (!buckets.has(key)) {
			buckets.set(key, []);
			order.push(key);
		}
		buckets.get(key)!.push(model);
	}
	return order.map(key => ({ label: key || undefined, models: buckets.get(key)! }));
}

function formatWeight(weight: number): string {
	// Render as compact multiplier, e.g. 1, 1.6, 0.3 -> "1.0x" style used in the reference UI.
	const rounded = Math.round(weight * 10) / 10;
	return `${rounded.toFixed(1)}x`;
}

function formatRuntimeMeta(state: IMicroIDEAgentState): string {
	const parts = [state.engine, state.protocolVersion].filter(Boolean);
	if (state.engine) {
		return parts.join(' / ');
	}
	return state.session?.status ?? '';
}

function normalizeTaskBrowserUrl(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) {
		return 'about:blank';
	}
	if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) {
		return trimmed;
	}
	if (/^(localhost|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:[/?#].*)?$/i.test(trimmed)) {
		return 'http://' + trimmed;
	}
	if (/^[^\s]+\.[^\s]+(?:[/?#].*)?$/.test(trimmed)) {
		return 'https://' + trimmed;
	}
	return 'https://www.google.com/search?q=' + encodeURIComponent(trimmed);
}

function formatHost(value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}

	try {
		return new URL(value).host;
	} catch {
		return value;
	}
}

function appendIconButton(container: HTMLElement, icon: ThemeIcon, label: string, kind: string): HTMLButtonElement {
	const button = dom.append(container, dom.$(`button.microide-button.${kind.replace(/\s+/g, '.')}`)) as HTMLButtonElement;
	button.type = 'button';
	button.title = label;
	appendIcon(button, icon);
	const text = dom.append(button, dom.$('span.microide-button-label'));
	text.textContent = label;
	return button;
}

function appendIcon(container: HTMLElement, icon: ThemeIcon): HTMLElement {
	const element = dom.append(container, dom.$('span.microide-icon'));
	element.classList.add(...ThemeIcon.asClassNameArray(icon));
	return element;
}

function isAskUserQuestionToolName(toolName: string | undefined): boolean {
	return toolName?.toLowerCase() === 'askuserquestion';
}

function parseAskUserQuestionInput(value: unknown): IMicroIDEAskUserQuestionInput | undefined {
	const record = asObjectRecord(value);
	if (!record || !Array.isArray(record['questions'])) {
		return undefined;
	}

	const questions: IMicroIDEAskUserQuestion[] = [];
	for (const item of record['questions']) {
		const questionRecord = asObjectRecord(item);
		const question = getObjectString(questionRecord, 'question');
		const rawOptions = Array.isArray(questionRecord?.['options']) ? questionRecord['options'] : [];
		const options: IMicroIDEAskUserQuestionOption[] = [];

		for (const option of rawOptions) {
			const optionRecord = asObjectRecord(option);
			const label = getObjectString(optionRecord, 'label');
			if (!label) {
				continue;
			}
			const description = getObjectString(optionRecord, 'description');
			const preview = getObjectString(optionRecord, 'preview');
			options.push({
				label,
				...(description ? { description } : {}),
				...(preview ? { preview } : {})
			});
		}

		if (!question || options.length === 0) {
			continue;
		}

		const header = getObjectString(questionRecord, 'header');
		questions.push({
			question,
			...(header ? { header } : {}),
			options,
			...(questionRecord?.['multiSelect'] === true ? { multiSelect: true } : {})
		});
	}

	if (!questions.length) {
		return undefined;
	}

	return {
		questions,
		...(asStringRecord(record['answers']) ? { answers: asStringRecord(record['answers']) } : {}),
		...(asObjectRecord(record['annotations']) ? { annotations: asObjectRecord(record['annotations']) } : {}),
		...(record['metadata'] !== undefined ? { metadata: record['metadata'] } : {})
	};
}

function askUserQuestionDialogTitle(input: IMicroIDEAskUserQuestionInput): string {
	if (input.questions.length === 1) {
		return input.questions[0].header || localize('microide.askUserQuestionTitle', "Question");
	}
	return localize('microide.askUserQuestionTitleMany', "Questions");
}

function askUserQuestionDialogMeta(input: IMicroIDEAskUserQuestionInput): string {
	return input.questions.length === 1
		? localize('microide.askUserQuestionMetaSingle', "microClaude needs your answer")
		: localize('microide.askUserQuestionMetaMany', "{0} questions from microClaude", input.questions.length);
}

function askUserQuestionToolTitle(input: IMicroIDEAskUserQuestionInput): string {
	if (input.questions.length === 1) {
		return truncateSingleLine(input.questions[0].question, 96);
	}
	return localize('microide.askUserQuestionToolTitleMany', "Answer {0} questions", input.questions.length);
}

function splitAskUserAnswer(value: string | undefined): string[] {
	return value
		? value.split(',').map(item => item.trim()).filter(Boolean)
		: [];
}

function sanitizeIdFragment(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, '-');
}

function asObjectRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function extractObjectRecord(value: unknown): Record<string, unknown> | undefined {
	if (Array.isArray(value)) {
		for (const item of value) {
			const record = extractObjectRecord(item);
			if (record) {
				return record;
			}
		}
		return undefined;
	}
	if (typeof value === 'string') {
		try {
			return extractObjectRecord(JSON.parse(value));
		} catch {
			return undefined;
		}
	}
	const record = asObjectRecord(value);
	if (!record) {
		return undefined;
	}
	return asObjectRecord(record['data']) ?? asObjectRecord(record['result']) ?? record;
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
	const record = asObjectRecord(value);
	if (!record) {
		return undefined;
	}
	const result: Record<string, string> = {};
	for (const [key, item] of Object.entries(record)) {
		if (typeof item === 'string') {
			result[key] = item;
		}
	}
	return Object.keys(result).length ? result : undefined;
}

function getObjectString(record: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = record?.[key];
	return typeof value === 'string' && value.trim() ? value : undefined;
}

function statusLabel(status: IMicroIDEAgentState['status']): string {
	switch (status) {
		case 'starting':
			return localize('microide.statusStarting', "Starting");
		case 'ready':
			return localize('microide.statusReady', "Ready");
		case 'busy':
			return localize('microide.statusBusy', "Busy");
		case 'error':
			return localize('microide.statusError', "Error");
		default:
			return localize('microide.statusIdle', "Idle");
	}
}

function messageRoleLabel(role: IMicroIDEAgentMessage['role']): string {
	switch (role) {
		case 'assistant':
			return localize('microide.roleAssistant', "microClaude");
		case 'user':
			return localize('microide.roleUser', "You");
		case 'tool':
			return localize('microide.roleTool', "Tool");
		default:
			return localize('microide.roleSystem', "System");
	}
}

function permissionRequestEffect(request: IMicroIDEPermissionRequest): MicroIDEToolEffect {
	const tool = request.toolName.toLowerCase();
	if (request.command || tool.includes('bash') || tool.includes('shell') || tool.includes('powershell') || tool.includes('terminal')) {
		return 'command';
	}
	if (tool.includes('write') || tool.includes('edit') || tool.includes('patch') || tool.includes('notebook')) {
		return 'edit';
	}
	if (tool.includes('web') || tool.includes('browser') || tool.includes('fetch') || tool.includes('search') || tool.includes('mcp')) {
		return 'network';
	}
	if (tool.includes('memory') || tool.includes('knowledge')) {
		return 'memory';
	}
	if (request.path || tool.includes('read') || tool.includes('file') || tool.includes('grep') || tool.includes('glob') || tool.includes('list')) {
		return 'read';
	}
	return 'other';
}

function permissionPromptTitle(request: IMicroIDEPermissionRequest): string {
	switch (permissionRequestEffect(request)) {
	case 'command':
		return localize('microide.permissionPromptCommand', "Run this command?");
	case 'edit':
		return request.path
			? localize('microide.permissionPromptWritePath', "Allow write to {0}?", request.path)
			: localize('microide.permissionPromptEdit', "Allow this file change?");
	case 'read':
		return localize('microide.permissionPromptRead', "Allow this read?");
	case 'network':
		return localize('microide.permissionPromptNetwork', "Allow this external tool?");
	case 'memory':
		return localize('microide.permissionPromptMemory', "Allow memory access?");
	default:
		return localize('microide.permissionPromptGeneric', "Allow {0}?", request.toolName);
	}
}

function permissionModeIcon(mode: MicroIDEPermissionMode): ThemeIcon {
	switch (mode) {
		case 'ask':
			return Codicon.lock;
		case 'fullAccess':
			return Codicon.warning;
		default:
			return Codicon.shield;
	}
}

function permissionModeShortLabel(mode: MicroIDEPermissionMode): string {
	switch (mode) {
		case 'ask':
			return localize('microide.permissionModeAskShort', "Ask");
		case 'fullAccess':
			return localize('microide.permissionModeFullShort', "Full");
		default:
			return localize('microide.permissionModeAutoShort', "Edits auto");
	}
}

function teamStatusLabel(status: IMicroIDEAgentState['team']['status']): string {
	switch (status) {
		case 'active':
			return localize('microide.teamStatusActive', "Active");
		case 'deleting':
			return localize('microide.teamStatusDeleting', "Cleaning up");
		case 'error':
			return localize('microide.teamStatusError', "Needs attention");
		default:
			return localize('microide.teamStatusInactive', "Ready");
	}
}

function taskStatusIcon(status: string): ThemeIcon {
	const normalized = status.toLowerCase();
	if (normalized === 'completed' || normalized === 'complete' || normalized === 'done') {
		return Codicon.check;
	}
	if (normalized === 'running' || normalized === 'in_progress' || normalized === 'in-progress') {
		return Codicon.sync;
	}
	if (normalized === 'blocked' || normalized === 'failed' || normalized === 'error') {
		return Codicon.warning;
	}
	return Codicon.checklist;
}

function cssToken(value: string): string {
	return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

function formatTime(value: number): string {
	return new Date(value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatSessionTime(value: number): string {
	return new Date(value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
