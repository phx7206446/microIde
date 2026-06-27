/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { getErrorMessage } from '../../../../base/common/errors.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ILanguageModelsConfigurationService, ILanguageModelsProviderGroup } from '../common/languageModelsConfiguration.js';
import { DEFAULT_LANGUAGE_MODEL_PRESETS, DEFAULT_LANGUAGE_MODEL_PRESETS_VERSION } from '../common/defaultLanguageModelPresets.js';

/**
 * Seeds the product's shipped language-model presets into the user-editable
 * `chatLanguageModels.json` on first run (and once more whenever the shipped
 * preset version is bumped).
 *
 * Design constraints — this is IDE-shell behaviour only and must never assume
 * anything about the underlying AI engine:
 *  - Writes through {@link ILanguageModelsConfigurationService}, which only
 *    persists to the config file. It does NOT require the preset's vendor to be
 *    registered, so a preset stays inert and harmless until (if ever) its
 *    vendor backend appears.
 *  - Seeds by `vendor:name` and skips any group the user already has, so manual
 *    edits and removals are preserved. A bumped version re-seeds only entries
 *    that are still missing.
 */
export class PresetLanguageModelsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.presetLanguageModels';

	/** Records the highest preset version already seeded, so we seed each version at most once. */
	private static readonly STORAGE_KEY_SEEDED_VERSION = 'chat.languageModelPresets.seededVersion';

	constructor(
		@ILanguageModelsConfigurationService private readonly _configurationService: ILanguageModelsConfigurationService,
		@IStorageService private readonly _storageService: IStorageService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._seedIfNeeded();
	}

	private _seedIfNeeded(): void {
		if (DEFAULT_LANGUAGE_MODEL_PRESETS.length === 0) {
			return; // nothing shipped to seed
		}

		const seededVersion = this._storageService.getNumber(
			PresetLanguageModelsContribution.STORAGE_KEY_SEEDED_VERSION,
			StorageScope.APPLICATION,
			0,
		);
		if (seededVersion >= DEFAULT_LANGUAGE_MODEL_PRESETS_VERSION) {
			return; // already seeded at this (or a newer) preset version
		}

		// Wait for the first config-file load so we can diff against what the
		// user already has. whenReady never rejects.
		this._configurationService.whenReady.then(() => {
			if (this._store.isDisposed) {
				return;
			}
			return this._seed();
		}).finally(() => {
			if (!this._store.isDisposed) {
				// Record the version even if individual adds failed, so we don't
				// retry endlessly on every startup. Missing entries can be
				// re-seeded by bumping the preset version.
				this._storageService.store(
					PresetLanguageModelsContribution.STORAGE_KEY_SEEDED_VERSION,
					DEFAULT_LANGUAGE_MODEL_PRESETS_VERSION,
					StorageScope.APPLICATION,
					StorageTarget.MACHINE,
				);
			}
		});
	}

	private async _seed(): Promise<void> {
		const existing = this._configurationService.getLanguageModelsProviderGroups();
		const existingKeys = new Set(existing.map(g => `${g.vendor}:${g.name}`));

		for (const preset of DEFAULT_LANGUAGE_MODEL_PRESETS) {
			const key = `${preset.vendor}:${preset.name}`;
			if (existingKeys.has(key)) {
				continue; // user already has this group (kept, edited, or re-added) — never clobber
			}
			try {
				// Clone so the shipped constant is never mutated by the config layer
				// (it strips range/modelsRange in place on persist).
				await this._configurationService.addLanguageModelsProviderGroup({ ...preset } as ILanguageModelsProviderGroup);
				existingKeys.add(key);
			} catch (error) {
				// Best-effort: a failed preset must not block the others or startup.
				this._logService.warn(`[LM presets] Failed to seed preset "${key}": ${getErrorMessage(error)}`);
			}
		}
	}
}
