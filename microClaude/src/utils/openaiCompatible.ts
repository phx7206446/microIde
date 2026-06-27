import { getInitialSettings, getSettingsForSource } from './settings/settings.js'

export const OPENAI_COMPATIBLE_DEFAULT_BASE_URL = 'https://api.vveai.com/v1'
export const OPENAI_COMPATIBLE_DEFAULT_MODEL = 'gemini-3.1-pro-preview'
export const OPENAI_COMPATIBLE_MODELS_ENV = 'OPENAI_COMPATIBLE_MODELS'
export const OPENAI_COMPATIBLE_MODEL_CONFIGS_ENV =
  'OPENAI_COMPATIBLE_MODEL_CONFIGS'

export type OpenAICompatibleModelConfig = {
  apiKey?: string
  baseURL?: string
  contextWindow?: number
  defaultMaxTokens?: number
  defaultModel: string
  models: string[]
  name?: string
  parallelToolCalls?: boolean
  smallFastModel?: string
  streamRequired?: boolean
  upperMaxTokensLimit?: number
}

function getConfiguredEnvValue(name: string): string | undefined {
  const processValue = process.env[name]
  if (processValue) {
    return processValue
  }

  const settingsValue = getInitialSettings().env?.[name]
  if (
    settingsValue === undefined ||
    settingsValue === null ||
    String(settingsValue).trim() === ''
  ) {
    return undefined
  }

  return String(settingsValue)
}

function parseConfiguredModelList(raw: string | undefined): string[] {
  if (!raw) {
    return []
  }

  return Array.from(
    new Set(
      raw
        .split(/[,\n]/)
        .map(value => value.trim())
        .filter(Boolean),
    ),
  )
}

function restoreEnvValue(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name]
    return
  }

  process.env[name] = value
}

function parseModelConfigListFromValue(
  raw: string | undefined,
): OpenAICompatibleModelConfig[] {
  if (!raw) {
    return []
  }

  try {
    const parsed = JSON.parse(raw) as unknown
    const entries = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object'
        ? Object.entries(parsed).map(([name, value]) => ({
            ...(value && typeof value === 'object' ? value : {}),
            name,
          }))
        : []

    return entries
      .map(normalizeModelConfigEntry)
      .filter(
        (entry): entry is OpenAICompatibleModelConfig => entry !== undefined,
      )
  } catch {
    return []
  }
}

function normalizeModelConfigEntry(
  entry: unknown,
): OpenAICompatibleModelConfig | undefined {
  if (!entry || typeof entry !== 'object') {
    return undefined
  }

  const record = entry as Record<string, unknown>
  const defaultModel = getOptionalNonEmptyString(record.defaultModel)
  const singleModel = getOptionalNonEmptyString(record.model)
  const defaultMaxTokens = getOptionalPositiveInteger(record.defaultMaxTokens)
  const models = Array.from(
    new Set(
      [
        ...(Array.isArray(record.models)
          ? record.models
              .filter((value): value is string => typeof value === 'string')
              .map(value => value.trim())
              .filter(Boolean)
          : typeof record.models === 'string'
            ? parseConfiguredModelList(record.models)
            : []),
        defaultModel,
        singleModel,
      ].filter((value): value is string => Boolean(value)),
    ),
  )

  const resolvedDefaultModel = defaultModel || singleModel || models[0]
  if (!resolvedDefaultModel) {
    return undefined
  }

  return {
    apiKey: getOptionalNonEmptyString(record.apiKey),
    baseURL: getOptionalNonEmptyString(record.baseURL),
    contextWindow: getOptionalPositiveInteger(record.contextWindow),
    defaultMaxTokens,
    defaultModel: resolvedDefaultModel,
    models,
    name: getOptionalNonEmptyString(record.name),
    parallelToolCalls:
      getOptionalBoolean(record.parallelToolCalls) ??
      getOptionalBoolean(record.supportsParallelToolCalls),
    smallFastModel: getOptionalNonEmptyString(record.smallFastModel),
    streamRequired:
      getOptionalBoolean(record.streamRequired) ??
      getOptionalBoolean(record.streamingOnly) ??
      getOptionalBoolean(record.requiresStream),
    upperMaxTokensLimit: getOptionalPositiveInteger(record.upperMaxTokensLimit),
  }
}

function getOptionalNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function getOptionalPositiveInteger(value: unknown): number | undefined {
  const parsed =
    typeof value === 'string' && value.trim() !== ''
      ? Number(value.trim())
      : value

  if (
    typeof parsed !== 'number' ||
    !Number.isFinite(parsed) ||
    !Number.isInteger(parsed) ||
    parsed <= 0
  ) {
    return undefined
  }

  return parsed
}

function getOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value
  }

  if (typeof value !== 'string') {
    return undefined
  }

  const normalized = value.trim().toLowerCase()
  if (normalized === 'true') {
    return true
  }
  if (normalized === 'false') {
    return false
  }

  return undefined
}

function getConfiguredModelConfigs(): OpenAICompatibleModelConfig[] {
  return parseModelConfigListFromValue(
    getConfiguredEnvValue(OPENAI_COMPATIBLE_MODEL_CONFIGS_ENV),
  )
}

function getLegacyModelConfig(): OpenAICompatibleModelConfig | undefined {
  const defaultModel = getConfiguredEnvValue('OPENAI_MODEL')
  const configuredModels = parseConfiguredModelList(
    getConfiguredEnvValue(OPENAI_COMPATIBLE_MODELS_ENV),
  )
  const models = Array.from(
    new Set(
      [defaultModel, ...configuredModels].filter(
        (value): value is string => Boolean(value),
      ),
    ),
  )

  const baseURL = getConfiguredEnvValue('OPENAI_BASE_URL')
  const apiKey = getConfiguredEnvValue('OPENAI_API_KEY')
  const smallFastModel = getConfiguredEnvValue('OPENAI_SMALL_FAST_MODEL')
  const resolvedDefaultModel = defaultModel || models[0]

  if (!resolvedDefaultModel && !baseURL && !apiKey) {
    return undefined
  }

  return {
    apiKey: apiKey || undefined,
    baseURL,
    defaultModel: resolvedDefaultModel || OPENAI_COMPATIBLE_DEFAULT_MODEL,
    models:
      models.length > 0 ? models : [resolvedDefaultModel || OPENAI_COMPATIBLE_DEFAULT_MODEL],
    name: 'legacy',
    smallFastModel: smallFastModel || undefined,
  }
}

function getAllOpenAICompatibleModelConfigs(): OpenAICompatibleModelConfig[] {
  const configured = getConfiguredModelConfigs()
  const legacy = getLegacyModelConfig()
  return legacy ? [...configured, legacy] : configured
}

function getOpenAICompatibleConfigForModel(
  model: string | null | undefined,
): OpenAICompatibleModelConfig | undefined {
  const normalized = model?.trim().toLowerCase()
  if (!normalized) {
    return getAllOpenAICompatibleModelConfigs()[0]
  }

  return getAllOpenAICompatibleModelConfigs().find(config =>
    config.models.some(candidate => candidate.toLowerCase() === normalized),
  )
}

export function resolveOpenAICompatibleModelConfig(
  model: string | null | undefined,
): OpenAICompatibleModelConfig | undefined {
  return getOpenAICompatibleConfigForModel(model)
}

export function getOpenAICompatibleModel(): string {
  return (
    getConfiguredEnvValue('OPENAI_MODEL') ||
    getAllOpenAICompatibleModelConfigs()[0]?.defaultModel ||
    OPENAI_COMPATIBLE_DEFAULT_MODEL
  )
}

export function getOpenAICompatibleBaseURL(
  model?: string | null,
): string {
  return (
    getOpenAICompatibleConfigForModel(model || getOpenAICompatibleModel())
      ?.baseURL ||
    getConfiguredEnvValue('OPENAI_BASE_URL') ||
    OPENAI_COMPATIBLE_DEFAULT_BASE_URL
  )
}

export function getOpenAICompatibleApiKey(
  model?: string | null,
): string | null {
  return (
    getOpenAICompatibleConfigForModel(model || getOpenAICompatibleModel())
      ?.apiKey ||
    getConfiguredEnvValue('OPENAI_API_KEY') ||
    null
  )
}

export function getOpenAICompatibleSmallFastModel(
  model?: string | null,
): string {
  return (
    getOpenAICompatibleConfigForModel(model || getOpenAICompatibleModel())
      ?.smallFastModel ||
    getConfiguredEnvValue('OPENAI_SMALL_FAST_MODEL') ||
    getOpenAICompatibleModel()
  )
}

export function getOpenAICompatibleAvailableModels(): string[] {
  const configured = Array.from(
    new Set(
      getAllOpenAICompatibleModelConfigs().flatMap(config => config.models),
    ),
  )
  if (configured.length > 0) {
    return configured
  }

  const configuredDefault = getConfiguredEnvValue('OPENAI_MODEL')
  return configuredDefault ? [configuredDefault] : []
}

export function getOpenAICompatibleParallelToolCalls(
  model: string | null | undefined,
): boolean {
  return getOpenAICompatibleConfigForModel(model)?.parallelToolCalls ?? false
}

export function getOpenAICompatibleStreamRequired(
  model: string | null | undefined,
): boolean {
  return getOpenAICompatibleConfigForModel(model)?.streamRequired ?? false
}

export function isOpenAICompatibleModel(
  model: string | null | undefined,
): boolean {
  if (!model) {
    return false
  }

  const normalized = model.trim().toLowerCase()
  return getOpenAICompatibleAvailableModels().some(
    candidate => candidate.toLowerCase() === normalized,
  )
}

export function hasProjectOpenAICompatibleConfiguration(): boolean {
  const env = getSettingsForSource('localSettings')?.env
  if (!env) {
    return false
  }

  const configuredModelConfigs = parseModelConfigListFromValue(
    typeof env[OPENAI_COMPATIBLE_MODEL_CONFIGS_ENV] === 'string'
      ? env[OPENAI_COMPATIBLE_MODEL_CONFIGS_ENV]
      : undefined,
  )

  return Boolean(
    configuredModelConfigs.length > 0 ||
      (env.OPENAI_API_KEY &&
        (env.OPENAI_BASE_URL ||
          env.OPENAI_MODEL ||
          env[OPENAI_COMPATIBLE_MODELS_ENV])),
  )
}

export function syncOpenAICompatibleEnvironment(
  model: string | null | undefined,
): void {
  if (!isOpenAICompatibleModel(model)) {
    delete process.env.CLAUDE_CODE_USE_OPENAI_COMPATIBLE
    return
  }

  process.env.CLAUDE_CODE_USE_OPENAI_COMPATIBLE = '1'
  delete process.env.CLAUDE_CODE_USE_OLLAMA
  process.env.OPENAI_BASE_URL = getOpenAICompatibleBaseURL(model)

  const apiKey = getOpenAICompatibleApiKey(model)
  if (apiKey) {
    process.env.OPENAI_API_KEY = apiKey
  } else {
    delete process.env.OPENAI_API_KEY
  }

  if (model) {
    process.env.OPENAI_MODEL = model.trim()
  }

  const smallFastModel = getOpenAICompatibleSmallFastModel(model)
  if (smallFastModel) {
    process.env.OPENAI_SMALL_FAST_MODEL = smallFastModel
  }
}

export async function withOpenAICompatibleEnvironmentForModel<T>(
  model: string,
  callback: () => Promise<T>,
): Promise<T> {
  if (!isOpenAICompatibleModel(model)) {
    return callback()
  }

  const snapshot = {
    CLAUDE_CODE_USE_OLLAMA: process.env.CLAUDE_CODE_USE_OLLAMA,
    CLAUDE_CODE_USE_OPENAI_COMPATIBLE:
      process.env.CLAUDE_CODE_USE_OPENAI_COMPATIBLE,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_MODEL: process.env.OPENAI_MODEL,
    OPENAI_SMALL_FAST_MODEL: process.env.OPENAI_SMALL_FAST_MODEL,
  }

  syncOpenAICompatibleEnvironment(model)

  try {
    return await callback()
  } finally {
    restoreEnvValue('CLAUDE_CODE_USE_OLLAMA', snapshot.CLAUDE_CODE_USE_OLLAMA)
    restoreEnvValue(
      'CLAUDE_CODE_USE_OPENAI_COMPATIBLE',
      snapshot.CLAUDE_CODE_USE_OPENAI_COMPATIBLE,
    )
    restoreEnvValue('OPENAI_BASE_URL', snapshot.OPENAI_BASE_URL)
    restoreEnvValue('OPENAI_API_KEY', snapshot.OPENAI_API_KEY)
    restoreEnvValue('OPENAI_MODEL', snapshot.OPENAI_MODEL)
    restoreEnvValue('OPENAI_SMALL_FAST_MODEL', snapshot.OPENAI_SMALL_FAST_MODEL)
  }
}
