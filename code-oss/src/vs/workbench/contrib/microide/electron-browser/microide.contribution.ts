/*---------------------------------------------------------------------------------------------
 *  Copyright (c) MicroIDE contributors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IMicroClaudeSidecarService } from '../../../../platform/microide/common/microClaudeSidecarService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem, QuickPickInput } from '../../../../platform/quickinput/common/quickInput.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { getWindowId } from '../../../../base/browser/dom.js';
import { URI } from '../../../../base/common/uri.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { localize, localize2 } from '../../../../nls.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { Extensions as ViewContainerExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation } from '../../../common/views.js';
import { IActivityService, NumberBadge } from '../../../services/activity/common/activity.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { MicroIDEAgentPanelView } from '../browser/microideAgentViews.js';
import '../browser/microideAgentService.js';
import '../browser/microideDiffService.js';
import {
	IMicroIDEAgentService,
	MICROIDE_AGENT_PANEL_VIEW_ID,
	MICROIDE_VIEW_CONTAINER_ID
} from '../common/microideAgentService.js';

const microIDEViewIcon = registerIcon('microide-view-icon', Codicon.agent, localize('microideViewIcon', 'View icon of MicroWorker.'));
const MICROIDE_WORKBUDDY_WORKBENCH_CLASS = 'microide-workbuddy-workbench';

function setMicroIDEWorkBuddyWorkbenchClass(active: boolean): void {
	if (typeof document === 'undefined' || !document.body) {
		return;
	}

	document.body.classList.toggle(MICROIDE_WORKBUDDY_WORKBENCH_CLASS, active);
}

setMicroIDEWorkBuddyWorkbenchClass(true);

const microIDEViewContainer = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry).registerViewContainer({
	id: MICROIDE_VIEW_CONTAINER_ID,
	title: localize2('microide.viewContainer', "MicroWorker"),
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [MICROIDE_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	icon: microIDEViewIcon,
	alwaysUseContainerInfo: true,
	order: 10,
	openCommandActionDescriptor: {
		id: MICROIDE_VIEW_CONTAINER_ID,
		mnemonicTitle: localize({ key: 'miViewMicroIDE', comment: ['&& denotes a mnemonic'] }, "Micro&&Worker"),
		order: 10
	}
}, ViewContainerLocation.AuxiliaryBar, { isDefault: true });

Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry).registerViews([{
	id: MICROIDE_AGENT_PANEL_VIEW_ID,
	name: localize2('microide.agentPanel', "Agent"),
	containerIcon: microIDEViewIcon,
	ctorDescriptor: new SyncDescriptor(MicroIDEAgentPanelView),
	canToggleVisibility: false,
	canMoveView: false,
	order: 1,
	weight: 100
}], microIDEViewContainer);

class MicroIDEPendingPermissionsActivity extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.microide.pendingPermissionsActivity';

	private readonly activity = this._register(new MutableDisposable());

	constructor(
		@IMicroIDEAgentService microIDEAgentService: IMicroIDEAgentService,
		@IActivityService private readonly activityService: IActivityService
	) {
		super();

		this._register(microIDEAgentService.onDidChangeState(() => this.updateActivity(microIDEAgentService.getPendingPermissionCount())));
		this.updateActivity(microIDEAgentService.getPendingPermissionCount());
	}

	private updateActivity(count: number): void {
		this.activity.clear();
		if (count <= 0) {
			return;
		}

		this.activity.value = this.activityService.showViewContainerActivity(MICROIDE_VIEW_CONTAINER_ID, {
			badge: new NumberBadge(count, value => value === 1
				? localize('microide.onePendingPermissionBadge', "1 MicroWorker permission request")
				: localize('microide.pendingPermissionBadge', "{0} MicroWorker permission requests", value))
		});
	}
}

registerWorkbenchContribution2(MicroIDEPendingPermissionsActivity.ID, MicroIDEPendingPermissionsActivity, WorkbenchPhase.AfterRestored);

class MicroIDEAgentPaneStartupContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.microide.agentPaneStartup';

	constructor(
		@IViewsService viewsService: IViewsService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@IMicroIDEAgentService microIDEAgentService: IMicroIDEAgentService
	) {
		super();

		this._register(this.layoutService.onDidChangeAuxiliaryBarMaximized(() => this.scheduleWorkBuddyWorkbenchActivation()));
		this._register(this.layoutService.onDidChangePartVisibility(event => {
			if (event.visible && (
				event.partId === Parts.ACTIVITYBAR_PART ||
				event.partId === Parts.STATUSBAR_PART ||
				event.partId === Parts.SIDEBAR_PART ||
				event.partId === Parts.PANEL_PART ||
				event.partId === Parts.EDITOR_PART
			)) {
				this.scheduleWorkBuddyWorkbenchActivation();
			}
		}));
		this.syncWorkBuddyWorkbenchChrome(true);

		void viewsService.openViewContainer(MICROIDE_VIEW_CONTAINER_ID, false)
			.then(() => {
				this.scheduleWorkBuddyWorkbenchActivation();
				return viewsService.openView(MICROIDE_AGENT_PANEL_VIEW_ID, false);
			})
			.then(() => microIDEAgentService.ensureReady())
			.catch(() => undefined);
	}

	private scheduleWorkBuddyWorkbenchActivation(): void {
		this.activateWorkBuddyWorkbench();
		for (const delay of [250, 1000]) {
			const handle = setTimeout(() => this.activateWorkBuddyWorkbench(), delay);
			this._register({ dispose: () => clearTimeout(handle) });
		}
	}

	private activateWorkBuddyWorkbench(): void {
		this.layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
		if (!this.layoutService.isAuxiliaryBarMaximized()) {
			this.layoutService.setAuxiliaryBarMaximized(true);
		}
		this.layoutService.setPartHidden(false, Parts.TITLEBAR_PART);
		this.layoutService.setPartHidden(true, Parts.ACTIVITYBAR_PART);
		this.layoutService.setPartHidden(true, Parts.STATUSBAR_PART);
		this.layoutService.setPartHidden(true, Parts.SIDEBAR_PART);
		this.layoutService.setPartHidden(true, Parts.PANEL_PART);
		this.layoutService.setPartHidden(true, Parts.EDITOR_PART);
		this.layoutService.focusPart(Parts.AUXILIARYBAR_PART);

		this.syncWorkBuddyWorkbenchChrome(true);
	}

	private syncWorkBuddyWorkbenchChrome(forceActive?: boolean): void {
		const active = forceActive !== false;
		document.body.classList.toggle(MICROIDE_WORKBUDDY_WORKBENCH_CLASS, active);
		this.nativeHostService.updateWindowControls({
			targetWindowId: getWindowId(mainWindow),
			backgroundColor: active ? '#f7f7f3' : undefined,
			foregroundColor: active ? '#202124' : undefined
		});
	}
}

registerWorkbenchContribution2(MicroIDEAgentPaneStartupContribution.ID, MicroIDEAgentPaneStartupContribution, WorkbenchPhase.AfterRestored);

registerAction2(class MicroIDENewChatAction extends Action2 {
	constructor() {
		super({
			id: 'microide.workbench.newChat',
			title: localize2('microide.newChat', 'MicroWorker: New Chat'),
			category: localize2('microide.category', 'MicroWorker'),
			f1: true
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const viewsService = accessor.get(IViewsService);
		const microIDEAgentService = accessor.get(IMicroIDEAgentService);

		await viewsService.openViewContainer(MICROIDE_VIEW_CONTAINER_ID, false);
		await viewsService.openView(MICROIDE_AGENT_PANEL_VIEW_ID, false);
		await microIDEAgentService.startNewSession();
	}
});

registerAction2(class MicroIDEPreviousChatAction extends Action2 {
	constructor() {
		super({
			id: 'microide.workbench.previousChat',
			title: localize2('microide.previousChat', 'MicroWorker: Previous Chat'),
			category: localize2('microide.category', 'MicroWorker'),
			f1: true
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const viewsService = accessor.get(IViewsService);
		const microIDEAgentService = accessor.get(IMicroIDEAgentService);
		const state = microIDEAgentService.getState();
		const sessions = state.sessions;
		if (sessions.length <= 1) {
			return;
		}

		const currentIndex = Math.max(0, sessions.findIndex(session => session.id === state.activeSessionId));
		const previousIndex = (currentIndex - 1 + sessions.length) % sessions.length;
		const previousSessionId = sessions[previousIndex]?.id;
		if (previousSessionId && previousSessionId !== state.activeSessionId) {
			await viewsService.openViewContainer(MICROIDE_VIEW_CONTAINER_ID, false);
			await viewsService.openView(MICROIDE_AGENT_PANEL_VIEW_ID, false);
			await microIDEAgentService.switchSession(previousSessionId);
		}
	}
});

registerAction2(class MicroIDENextChatAction extends Action2 {
	constructor() {
		super({
			id: 'microide.workbench.nextChat',
			title: localize2('microide.nextChat', 'MicroWorker: Next Chat'),
			category: localize2('microide.category', 'MicroWorker'),
			f1: true
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const viewsService = accessor.get(IViewsService);
		const microIDEAgentService = accessor.get(IMicroIDEAgentService);
		const state = microIDEAgentService.getState();
		const sessions = state.sessions;
		if (sessions.length <= 1) {
			return;
		}

		const currentIndex = Math.max(0, sessions.findIndex(session => session.id === state.activeSessionId));
		const nextIndex = (currentIndex + 1) % sessions.length;
		const nextSessionId = sessions[nextIndex]?.id;
		if (nextSessionId && nextSessionId !== state.activeSessionId) {
			await viewsService.openViewContainer(MICROIDE_VIEW_CONTAINER_ID, false);
			await viewsService.openView(MICROIDE_AGENT_PANEL_VIEW_ID, false);
			await microIDEAgentService.switchSession(nextSessionId);
		}
	}
});

registerAction2(class MicroIDESignOutAction extends Action2 {
	constructor() {
		super({
			id: 'microide.account.signOut',
			title: localize2('microide.signOut', 'MicroWorker: Log Out'),
			category: localize2('microide.category', 'MicroWorker'),
			f1: true
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const microIDEAgentService = accessor.get(IMicroIDEAgentService);
		await microIDEAgentService.signOut();
	}
});
registerAction2(class MicroIDEAccountAction extends Action2 {
	constructor() {
		super({
			id: 'microide.account',
			title: localize2('microide.account', 'MicroWorker Account'),
			category: localize2('microide.category', 'MicroWorker'),
			icon: Codicon.account,
			f1: true,
			menu: {
				id: MenuId.TitleBar,
				group: 'navigation',
				order: 99
			}
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const microIDEAgentService = accessor.get(IMicroIDEAgentService);
		const quickInputService = accessor.get(IQuickInputService);
		const commandService = accessor.get(ICommandService);
		const openerService = accessor.get(IOpenerService);
		const productService = accessor.get(IProductService);
		const state = microIDEAgentService.getState();

		const accountLabel = state.auth.displayName ?? state.auth.username ?? localize('microide.localSession', "Local session");
		const items: QuickPickInput<IQuickPickItem & { id: string }>[] = [
			{ type: 'separator', label: accountLabel },
			{ id: 'appSettings', label: localize('microide.appSettings', "MicroWorker Settings"), iconClass: ThemeIcon.asClassName(Codicon.settingsGear) },
			{ id: 'editorSettings', label: localize('microide.editorSettings', "Editor Settings"), iconClass: ThemeIcon.asClassName(Codicon.settings) },
			{ type: 'separator', label: localize('microide.helpSection', "Help & Feedback") },
			{ id: 'docs', label: localize('microide.helpDocs', "Help Docs"), iconClass: ThemeIcon.asClassName(Codicon.book) },
			{ id: 'feature', label: localize('microide.requestFeature', "Submit Feature Suggestion"), iconClass: ThemeIcon.asClassName(Codicon.lightbulb) },
			{ id: 'feedback', label: localize('microide.reportIssue', "Problem Feedback"), iconClass: ThemeIcon.asClassName(Codicon.feedback) },
		];

		const choice = await quickInputService.pick(items, {
			title: localize('microide.accountTitle', "MicroWorker"),
			placeHolder: accountLabel
		});
		if (!choice) {
			return;
		}

		const openUrl = async (url: string | undefined): Promise<void> => {
			if (url) {
				await openerService.open(URI.parse(url));
			}
		};

		switch (choice.id) {
			case 'appSettings':
				await commandService.executeCommand('workbench.action.openSettings', 'microide');
				return;
			case 'editorSettings':
				await commandService.executeCommand('workbench.action.openSettings', 'editor');
				return;
			case 'docs':
				await openUrl(productService.documentationUrl);
				return;
			case 'feature':
				await openUrl(productService.requestFeatureUrl);
				return;
			case 'feedback':
				await openUrl(productService.reportIssueUrl);
				return;
		}
	}
});

registerAction2(class MicroIDEPingMicroClaudeSidecarAction extends Action2 {
	constructor() {
		super({
			id: 'microide.microClaudeSidecar.ping',
			title: localize2('microide.pingMicroClaudeSidecar', 'MicroWorker: Ping sidecar'),
			category: localize2('microide.category', 'MicroWorker'),
			f1: true
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const microIDEAgentService = accessor.get(IMicroIDEAgentService);
		const microClaudeSidecarService = accessor.get(IMicroClaudeSidecarService);
		const notificationService = accessor.get(INotificationService);

		try {
			await microIDEAgentService.ensureReady();
			const result = await microClaudeSidecarService.ping();
			notificationService.info(localize(
				'microide.sidecarPingOk',
				'microClaude sidecar is running. PID: {0}, engine: {1}, protocol: {2}.',
				String(result.pid),
				result.engine,
				result.protocolVersion
			));
		} catch (error) {
			notificationService.error(localize(
				'microide.sidecarPingFailed',
				'microClaude sidecar ping failed: {0}',
				toErrorMessage(error)
			));
		}
	}
});
