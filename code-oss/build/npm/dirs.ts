/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync } from 'fs';

/**
 * Complete list of directories where npm should be executed to install node modules
 */
const allDirs = [
	'',
	'build',
	'build/rspack',
	'build/vite',
	'extensions',
	'extensions/configuration-editing',
	'extensions/css-language-features',
	'extensions/css-language-features/server',
	'extensions/debug-auto-launch',
	'extensions/debug-server-ready',
	'extensions/emmet',
	'extensions/extension-editing',
	'extensions/git',
	'extensions/git-base',
	'extensions/github',
	'extensions/github-authentication',
	'extensions/grunt',
	'extensions/gulp',
	'extensions/html-language-features',
	'extensions/html-language-features/server',
	'extensions/ipynb',
	'extensions/jake',
	'extensions/json-language-features',
	'extensions/json-language-features/server',
	'extensions/markdown-language-features',
	'extensions/markdown-math',
	'extensions/media-preview',
	'extensions/merge-conflict',
	'extensions/mermaid-markdown-features',
	'extensions/microsoft-authentication',
	'extensions/notebook-renderers',
	'extensions/npm',
	'extensions/php-language-features',
	'extensions/references-view',
	'extensions/search-result',
	'extensions/simple-browser',
	'extensions/tunnel-forwarding',
	'extensions/terminal-suggest',
	'extensions/typescript-language-features',
	'extensions/vscode-api-tests',
	'extensions/vscode-colorize-tests',
	'extensions/vscode-colorize-perf-tests',
	'extensions/vscode-test-resolver',
	'remote',
	'remote/web',
	'test/automation',
	'test/integration/browser',
	'test/monaco',
	'test/smoke',
	'test/mcp',
	'.vscode/extensions/vscode-selfhost-import-aid',
	'.vscode/extensions/vscode-selfhost-test-provider',
	'.vscode/extensions/vscode-extras',
	'.vscode/extensions/vscode-pr-pinger',
];

if (existsSync(`${import.meta.dirname}/../../.build/distro/npm`)) {
	allDirs.push('.build/distro/npm');
	allDirs.push('.build/distro/npm/remote');
	allDirs.push('.build/distro/npm/remote/web');
}

const uiSmokeSkippedDirs = new Set<string>([
	'extensions/grunt',
	'extensions/gulp',
	'extensions/github-authentication',
	'extensions/ipynb',
	'extensions/jake',
	'extensions/markdown-math',
	'extensions/media-preview',
	'extensions/mermaid-markdown-features',
	'extensions/microsoft-authentication',
	'extensions/notebook-renderers',
	'extensions/php-language-features',
	'extensions/simple-browser',
	'extensions/tunnel-forwarding',
	'extensions/vscode-api-tests',
	'extensions/vscode-colorize-tests',
	'extensions/vscode-colorize-perf-tests',
	'extensions/vscode-test-resolver',
	'remote',
	'remote/web',
	'test/automation',
	'test/integration/browser',
	'test/monaco',
	'test/smoke',
	'test/mcp',
	'.vscode/extensions/vscode-selfhost-import-aid',
	'.vscode/extensions/vscode-selfhost-test-provider',
	'.vscode/extensions/vscode-extras',
	'.vscode/extensions/vscode-pr-pinger',
	'.build/distro/npm/remote',
	'.build/distro/npm/remote/web',
]);

function selectDirs(): string[] {
	const profile = process.env['MICROIDE_NPM_INSTALL_PROFILE'] ?? 'full';

	if (profile === 'full') {
		return allDirs;
	}

	if (profile === 'ui-smoke') {
		const selectedDirs = allDirs.filter(dir => !uiSmokeSkippedDirs.has(dir));
		console.log(`[build/npm/dirs] MICROIDE_NPM_INSTALL_PROFILE=ui-smoke; installing ${selectedDirs.length}/${allDirs.length} npm directories.`);
		return selectedDirs;
	}

	throw new Error(`Unsupported MICROIDE_NPM_INSTALL_PROFILE "${profile}". Expected "full" or "ui-smoke".`);
}

export const dirs = selectDirs();
