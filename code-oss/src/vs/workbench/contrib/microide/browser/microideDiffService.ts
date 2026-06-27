/*---------------------------------------------------------------------------------------------
 *  Copyright (c) MicroIDE contributors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ITextModelContentProvider, ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { localize } from '../../../../nls.js';
import { ResourceContextKey } from '../../../common/contextkeys.js';
import { EditorResourceAccessor, EditorsOrder, SideBySideEditor } from '../../../common/editor.js';
import { ACTIVE_GROUP, IEditorService, SIDE_GROUP } from '../../../services/editor/common/editorService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import type { IMicroIDEDiffPreview } from '../common/microideAgentService.js';

export const MICROIDE_DIFF_SCHEME = 'microide-diff';
export const MICROIDE_PROPOSED_SCHEME = 'microide-proposed';

export const IMicroIDEDiffService = createDecorator<IMicroIDEDiffService>('microIDEDiffService');

export interface IMicroIDEProposedChangeOptions {
	readonly requestId?: string;
	readonly preserveFocus?: boolean;
}

export interface IMicroIDEDiffService {
	readonly _serviceBrand: undefined;
	/**
	 * Opens a real side-by-side diff editor for the given preview. The original/modified
	 * contents are reconstructed from the preview hunks and served through an in-memory
	 * content provider, so this works even when the on-disk file is unavailable.
	 */
	openDiff(diff: IMicroIDEDiffPreview): Promise<void>;
	/**
	 * Opens a Qoder-style proposed change editor: an inline diff in a side editor group
	 * backed by virtual, read-only content. Accept writes the proposal to the target file;
	 * reject closes the proposed editor without touching disk.
	 */
	openProposedChange(diff: IMicroIDEDiffPreview, options?: IMicroIDEProposedChangeOptions): Promise<void>;
	acceptActiveProposal(): Promise<void>;
	rejectActiveProposal(): Promise<void>;
	openActiveProposalTarget(): Promise<void>;
}

interface IMicroIDEProposal {
	readonly id: string;
	readonly requestId?: string;
	readonly diff: IMicroIDEDiffPreview;
	readonly target: URI;
	readonly originalUri: URI;
	readonly proposedUri: URI;
	readonly originalContent: string;
	readonly proposedContent: string;
}

/**
 * Serves reconstructed diff sides and proposed-change buffers for native editors. Ordinary
 * diff previews use {@link MICROIDE_DIFF_SCHEME}; pending write previews use
 * {@link MICROIDE_PROPOSED_SCHEME} on the modified side so editor-title actions can target
 * only proposed changes.
 */
export class MicroIDEDiffService extends Disposable implements IMicroIDEDiffService, ITextModelContentProvider {
	declare readonly _serviceBrand: undefined;

	private readonly contents = new Map<string, string>();
	private readonly proposals = new Map<string, IMicroIDEProposal>();
	private readonly proposalByRequestId = new Map<string, string>();
	private sequence = 0;

	constructor(
		@ITextModelService textModelService: ITextModelService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IEditorService private readonly editorService: IEditorService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService
	) {
		super();
		this._register(textModelService.registerTextModelContentProvider(MICROIDE_DIFF_SCHEME, this));
		this._register(textModelService.registerTextModelContentProvider(MICROIDE_PROPOSED_SCHEME, this));
	}

	async openDiff(diff: IMicroIDEDiffPreview): Promise<void> {
		const { original, modified } = reconstructSides(diff);
		const id = `${Date.now()}-${++this.sequence}`;
		const basename = basenameLike(diff.filePath);
		const originalUri = this.stash(MICROIDE_DIFF_SCHEME, id, 'original', basename, diff.originalContent ?? original);
		const modifiedUri = this.stash(MICROIDE_DIFF_SCHEME, id, 'modified', basename, diff.proposedContent ?? modified);

		await this.editorService.openEditor({
			original: { resource: originalUri },
			modified: { resource: modifiedUri },
			label: localize('microide.diffEditorLabel', "{0} (microClaude change)", basename),
			options: { preserveFocus: false }
		});
	}

	async openProposedChange(diff: IMicroIDEDiffPreview, options: IMicroIDEProposedChangeOptions = {}): Promise<void> {
		const target = this.resolveTargetResource(diff.filePath);
		if (!target) {
			this.logService.warn(`[microide] proposed change target could not be resolved: ${diff.filePath}`);
			return;
		}

		const existing = options.requestId ? this.getProposalByRequestId(options.requestId) : undefined;
		if (existing) {
			await this.editorService.openEditor({
				original: { resource: existing.originalUri },
				modified: { resource: existing.proposedUri },
				label: proposedEditorLabel(existing.diff.filePath),
				options: proposedEditorOptions(options.preserveFocus ?? true)
			}, SIDE_GROUP);
			return;
		}

		const id = `${Date.now()}-${++this.sequence}`;
		const basename = basenameLike(diff.filePath);
		const { originalContent, proposedContent } = await this.resolveProposalSides(diff, target);
		const originalUri = this.stash(MICROIDE_DIFF_SCHEME, id, 'original', basename, originalContent);
		const proposedUri = this.stash(MICROIDE_PROPOSED_SCHEME, id, 'modified', basename, proposedContent);

		const proposal: IMicroIDEProposal = {
			id,
			requestId: options.requestId,
			diff,
			target,
			originalUri,
			proposedUri,
			originalContent,
			proposedContent
		};
		this.proposals.set(proposedUri.toString(), proposal);
		if (options.requestId) {
			this.proposalByRequestId.set(options.requestId, proposedUri.toString());
		}

		await this.editorService.openEditor({
			original: { resource: originalUri },
			modified: { resource: proposedUri },
			label: proposedEditorLabel(diff.filePath),
			options: proposedEditorOptions(options.preserveFocus ?? true)
		}, SIDE_GROUP);
	}

	async acceptActiveProposal(): Promise<void> {
		const proposal = this.getActiveProposal();
		if (!proposal) {
			return;
		}
		const currentContent = this.modelService.getModel(proposal.proposedUri)?.getValue() ?? proposal.proposedContent;
		await this.fileService.writeFile(proposal.target, VSBuffer.fromString(currentContent));
		await this.closeProposal(proposal);
		await this.editorService.openEditor({ resource: proposal.target, options: { preserveFocus: false } }, ACTIVE_GROUP);
	}

	async rejectActiveProposal(): Promise<void> {
		const proposal = this.getActiveProposal();
		if (!proposal) {
			return;
		}
		await this.closeProposal(proposal);
	}

	async openActiveProposalTarget(): Promise<void> {
		const proposal = this.getActiveProposal();
		if (!proposal) {
			return;
		}
		await this.editorService.openEditor({ resource: proposal.target, options: { preserveFocus: false } }, ACTIVE_GROUP);
	}

	async provideTextContent(resource: URI): Promise<ITextModel | null> {
		const existing = this.modelService.getModel(resource);
		if (existing) {
			return existing;
		}
		const content = this.contents.get(resource.toString());
		if (content === undefined) {
			return null;
		}
		// Derive the language from the basename embedded in the URI path.
		const language = this.languageService.createByFilepathOrFirstLine(URI.file(basenameLike(resource.path)));
		return this.modelService.createModel(content, language, resource);
	}

	private stash(scheme: string, id: string, side: 'original' | 'modified', basename: string, content: string): URI {
		const resource = URI.from({ scheme, path: `/${id}/${side}/${basename}` });
		this.contents.set(resource.toString(), content);
		return resource;
	}

	private resolveTargetResource(path: string): URI | undefined {
		const trimmed = path.trim();
		if (!trimmed) {
			return undefined;
		}
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
		return joinPath(folder.uri, ...trimmed.split(/[\\/]+/));
	}

	private getProposalByRequestId(requestId: string): IMicroIDEProposal | undefined {
		const key = this.proposalByRequestId.get(requestId);
		return key ? this.proposals.get(key) : undefined;
	}

	private async resolveProposalSides(diff: IMicroIDEDiffPreview, target: URI): Promise<{ originalContent: string; proposedContent: string }> {
		const reconstructed = reconstructSides(diff);
		if (diff.proposedContent !== undefined) {
			let originalContent = diff.originalContent;
			if (originalContent === undefined && !diff.isNewFile) {
				try {
					originalContent = (await this.fileService.readFile(target)).value.toString();
				} catch {
					originalContent = reconstructed.original;
				}
			}
			return {
				originalContent: originalContent ?? '',
				proposedContent: diff.proposedContent
			};
		}

		let originalContent = diff.originalContent;
		if (originalContent === undefined) {
			try {
				originalContent = (await this.fileService.readFile(target)).value.toString();
			} catch {
				originalContent = diff.isNewFile ? '' : reconstructed.original;
			}
		}

		return {
			originalContent,
			proposedContent: applyPreviewHunks(originalContent, diff) ?? reconstructed.modified
		};
	}

	private getActiveProposal(): IMicroIDEProposal | undefined {
		const activeEditor = this.editorService.activeEditor;
		const modified = EditorResourceAccessor.getOriginalUri(activeEditor, {
			supportSideBySide: SideBySideEditor.PRIMARY,
			filterByScheme: MICROIDE_PROPOSED_SCHEME
		});
		if (!modified) {
			return undefined;
		}
		return this.proposals.get(modified.toString());
	}

	private async closeProposal(proposal: IMicroIDEProposal): Promise<void> {
		for (const candidate of this.editorService.getEditors(EditorsOrder.SEQUENTIAL)) {
			const resource = EditorResourceAccessor.getOriginalUri(candidate.editor, {
				supportSideBySide: SideBySideEditor.PRIMARY,
				filterByScheme: MICROIDE_PROPOSED_SCHEME
			});
			if (resource?.toString() === proposal.proposedUri.toString()) {
				await this.editorService.closeEditor(candidate);
				break;
			}
		}
		this.proposals.delete(proposal.proposedUri.toString());
		if (proposal.requestId) {
			this.proposalByRequestId.delete(proposal.requestId);
		}
		this.contents.delete(proposal.originalUri.toString());
		this.contents.delete(proposal.proposedUri.toString());
	}
}

/**
 * Rebuilds the two sides of a change from preview hunks. Context lines appear on both sides,
 * removed lines only on the original, added lines only on the modified. Multiple hunks are
 * separated by a marker so the editor still shows a coherent, navigable comparison.
 */
function reconstructSides(diff: IMicroIDEDiffPreview): { original: string; modified: string } {
	const original: string[] = [];
	const modified: string[] = [];
	let first = true;
	for (const hunk of diff.hunks) {
		if (!first) {
			original.push('');
			modified.push('');
		}
		first = false;
		for (const line of hunk.lines) {
			if (line.kind === 'context') {
				original.push(line.text);
				modified.push(line.text);
			} else if (line.kind === 'removed') {
				original.push(line.text);
			} else {
				modified.push(line.text);
			}
		}
	}
	return { original: original.join('\n'), modified: modified.join('\n') };
}

function applyPreviewHunks(originalContent: string, diff: IMicroIDEDiffPreview): string | undefined {
	if (diff.isNewFile) {
		const added = diff.hunks.flatMap(hunk => hunk.lines.filter(line => line.kind !== 'removed').map(line => line.text));
		return added.join('\n');
	}

	let result = originalContent;
	let applied = false;
	for (const hunk of diff.hunks) {
		const oldText = hunk.lines
			.filter(line => line.kind !== 'added')
			.map(line => line.text)
			.join('\n');
		const newText = hunk.lines
			.filter(line => line.kind !== 'removed')
			.map(line => line.text)
			.join('\n');
		if (!oldText) {
			continue;
		}
		const index = result.indexOf(oldText);
		if (index < 0) {
			continue;
		}
		result = `${result.slice(0, index)}${newText}${result.slice(index + oldText.length)}`;
		applied = true;
	}
	return applied ? result : undefined;
}

function proposedEditorLabel(path: string): string {
	return localize('microide.proposedEditorLabel', "[Claude Code] {0}", path);
}

function proposedEditorOptions(preserveFocus: boolean) {
	return {
		pinned: true,
		preserveFocus,
		renderSideBySide: false,
		ignoreTrimWhitespace: false
	};
}

function basenameLike(path: string): string {
	const normalized = path.replace(/[\\/]+$/, '');
	const index = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
	return index >= 0 ? normalized.slice(index + 1) : normalized;
}

const proposedEditorWhen = ResourceContextKey.Scheme.isEqualTo(MICROIDE_PROPOSED_SCHEME);

registerAction2(class MicroIDEAcceptProposedChangesAction extends Action2 {
	constructor() {
		super({
			id: 'microide.proposed.accept',
			title: localize('microide.acceptProposedChanges', "Claude Code: Accept Proposed Changes"),
			category: localize('microide.category', "MicroWorker"),
			icon: Codicon.check,
			menu: {
				id: MenuId.EditorTitle,
				group: 'navigation',
				order: 0,
				when: proposedEditorWhen
			}
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IMicroIDEDiffService).acceptActiveProposal();
	}
});

registerAction2(class MicroIDEOpenProposedTargetAction extends Action2 {
	constructor() {
		super({
			id: 'microide.proposed.open',
			title: localize('microide.openProposedTarget', "Claude Code: Open"),
			category: localize('microide.category', "MicroWorker"),
			icon: Codicon.goToFile,
			menu: {
				id: MenuId.EditorTitle,
				group: 'navigation',
				order: 1,
				when: proposedEditorWhen
			}
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IMicroIDEDiffService).openActiveProposalTarget();
	}
});

registerAction2(class MicroIDERejectProposedChangesAction extends Action2 {
	constructor() {
		super({
			id: 'microide.proposed.reject',
			title: localize('microide.rejectProposedChanges', "Claude Code: Reject Proposed Changes"),
			category: localize('microide.category', "MicroWorker"),
			icon: Codicon.discard,
			menu: {
				id: MenuId.EditorTitle,
				group: 'navigation',
				order: 2,
				when: proposedEditorWhen
			}
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IMicroIDEDiffService).rejectActiveProposal();
	}
});

registerSingleton(IMicroIDEDiffService, MicroIDEDiffService, InstantiationType.Delayed);
