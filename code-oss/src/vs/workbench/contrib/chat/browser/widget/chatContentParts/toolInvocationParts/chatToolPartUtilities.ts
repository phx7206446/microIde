/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createMarkdownCommandLink, IMarkdownString, MarkdownString } from '../../../../../../../base/common/htmlContent.js';
import { localize } from '../../../../../../../nls.js';
import { IEditorService } from '../../../../../../services/editor/common/editorService.js';
import { IUntitledTextResourceEditorInput } from '../../../../../../common/editor.js';
import { ConfirmedReason, IChatToolInvocation, IChatToolInvocationSerialized, ToolConfirmKind } from '../../../../common/chatService/chatService.js';

/**
 * Output at or above this many lines is considered "large" and gets an
 * affordance to open the full content in a real editor in the main editor area,
 * where it is searchable, scrollable, and foldable.
 */
export const LARGE_OUTPUT_LINE_THRESHOLD = 30;

/** Whether `text` is large enough to warrant an "open in editor" affordance. */
export function isLargeTextOutput(text: string | undefined): boolean {
	if (!text) {
		return false;
	}
	// Count newlines without allocating a split array for very large strings.
	let lines = 1;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10 /* \n */) {
			lines++;
			if (lines >= LARGE_OUTPUT_LINE_THRESHOLD) {
				return true;
			}
		}
	}
	return false;
}

/**
 * Opens `text` as an untitled document in the main editor area, so large tool
 * output can be inspected with full editor affordances. Shell-only: this just
 * surfaces content the engine already produced.
 */
export function openTextInUntitledEditor(editorService: IEditorService, text: string, languageId?: string): void {
	editorService.openEditor({
		contents: text,
		languageId,
		resource: undefined,
	} satisfies IUntitledTextResourceEditorInput);
}

export function isMcpToolInvocation(toolInvocation: IChatToolInvocation | IChatToolInvocationSerialized): boolean {
	return toolInvocation.source?.type === 'mcp' || toolInvocation.toolId.toLowerCase().includes('mcp');
}

/**
 * Determines whether a tool invocation's progress text should shimmer.
 * MCP tools shimmer; askQuestions defers to the caller's default; all others opt out.
 */
export function shouldShimmerForTool(toolInvocation: IChatToolInvocation | IChatToolInvocationSerialized): boolean {
	if (isMcpToolInvocation(toolInvocation)) {
		return !IChatToolInvocation.isComplete(toolInvocation);
	}
	if (toolInvocation.toolId === 'copilot_askQuestions' || toolInvocation.toolId === 'vscode_askQuestions') {
		return false;
	}
	return false;
}

/**
 * Creates a markdown message explaining why a tool was auto-approved.
 * @param toolInvocation The tool invocation to get the approval message for
 * @returns A markdown string with the approval message, or undefined if no message should be shown
 */
export function getToolApprovalMessage(toolInvocation: IChatToolInvocation | IChatToolInvocationSerialized): IMarkdownString | undefined {
	const reason = IChatToolInvocation.executionConfirmedOrDenied(toolInvocation);
	if (!reason || typeof reason === 'boolean') {
		return undefined;
	}

	return getApprovalMessageFromReason(reason);
}

/**
 * Creates a markdown message from a ConfirmedReason explaining why a tool was auto-approved.
 * @param reason The confirmation reason
 * @returns A markdown string with the approval message, or undefined if no message should be shown
 */
export function getApprovalMessageFromReason(reason: ConfirmedReason): IMarkdownString | undefined {
	let md: string;
	switch (reason.type) {
		case ToolConfirmKind.Setting:
			md = localize('chat.autoapprove.setting', 'Auto approved by {0}', createMarkdownCommandLink({ text: '`' + reason.id + '`', id: 'workbench.action.openSettings', arguments: [reason.id], tooltip: localize('openSettings.tooltip', 'Open settings') }, false));
			break;
		case ToolConfirmKind.LmServicePerTool:
			md = reason.scope === 'session'
				? localize('chat.autoapprove.lmServicePerTool.session', 'Auto approved for this session')
				: reason.scope === 'workspace'
					? localize('chat.autoapprove.lmServicePerTool.workspace', 'Auto approved for this workspace')
					: localize('chat.autoapprove.lmServicePerTool.profile', 'Auto approved for this profile');
			md += ' (' + createMarkdownCommandLink({ text: localize('edit', 'Edit'), id: 'workbench.action.chat.editToolApproval', arguments: [reason.scope], tooltip: localize('editToolApproval.tooltip', 'Edit tool approval settings') }) + ')';
			break;
		case ToolConfirmKind.ConfirmationNotNeeded:
			if (reason.reason) {
				return typeof reason.reason === 'string'
					? new MarkdownString(reason.reason, { isTrusted: true })
					: reason.reason;
			}
			return undefined;
		case ToolConfirmKind.UserAction:
		case ToolConfirmKind.Denied:
		default:
			return undefined;
	}

	return new MarkdownString(md, { isTrusted: true });
}
