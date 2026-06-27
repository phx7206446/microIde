/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILanguageModelsProviderGroup } from './languageModelsConfiguration.js';

/**
 * Bump when the shipped presets change in a way that should re-seed users who
 * have not customised their configuration. The value is part of the storage key
 * so a new version seeds exactly once more, without clobbering edits made under
 * the previous version (see PresetLanguageModelsContribution).
 */
export const DEFAULT_LANGUAGE_MODEL_PRESETS_VERSION = 1;

/**
 * Default provider groups shipped with the product. These are seeded into the
 * user-editable `chatLanguageModels.json` on first run; users may freely add,
 * edit, or remove entries there afterwards.
 *
 * Each entry mirrors one object in `chatLanguageModels.json`:
 *   - `name`    display name of the group (shown in the model picker)
 *   - `vendor`  id of a registered provider backend (e.g. an OpenAI-compatible
 *               vendor such as `customoai`). Groups whose vendor is not
 *               registered stay inert until that vendor appears.
 *   - any vendor-specific config keys (e.g. `baseURL`, `apiKey`)
 *   - `models`  the list of models to expose, each `{ id, name }`
 *
 * Leave this array empty to ship no presets.
 */
export const DEFAULT_LANGUAGE_MODEL_PRESETS: readonly ILanguageModelsProviderGroup[] = [
	// Example preset — edit or remove. `apiKey` intentionally blank so the user fills it in.
	// {
	// 	name: 'Example OpenAI-Compatible',
	// 	vendor: 'customoai',
	// 	baseURL: 'https://api.example.com/v1',
	// 	apiKey: '',
	// 	models: [
	// 		{ id: 'gpt-4o', name: 'GPT-4o' },
	// 		{ id: 'gpt-4o-mini', name: 'GPT-4o mini' },
	// 	],
	// },
];
