import { getInitialSettings, getSettingsForSource } from './settings/settings.js'

export const OLLAMA_DEFAULT_BASE_URL = 'http://127.0.0.1:11434/v1'
export const OLLAMA_DEFAULT_MODEL = 'qwen2.5-coder:7b'
export const OLLAMA_MODELS_ENV = 'OLLAMA_MODELS'

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

export function getOllamaBaseURL(): string {
  return getConfiguredEnvValue('OLLAMA_BASE_URL') || OLLAMA_DEFAULT_BASE_URL
}

export function getOllamaApiKey(): string | null {
  return getConfiguredEnvValue('OLLAMA_API_KEY') || null
}

export function getOllamaModel(): string {
  return (
    getConfiguredEnvValue('OLLAMA_MODEL') ||
    parseConfiguredModelList(getConfiguredEnvValue(OLLAMA_MODELS_ENV))[0] ||
    OLLAMA_DEFAULT_MODEL
  )
}

export function getOllamaSmallFastModel(): string {
  return getConfiguredEnvValue('OLLAMA_SMALL_FAST_MODEL') || getOllamaModel()
}

export function getOllamaAvailableModels(): string[] {
  const configured = parseConfiguredModelList(
    getConfiguredEnvValue(OLLAMA_MODELS_ENV),
  )
  if (configured.length > 0) {
    return configured
  }

  const configuredDefault = getConfiguredEnvValue('OLLAMA_MODEL')
  return configuredDefault ? [configuredDefault] : []
}

export function isOllamaModel(model: string | null | undefined): boolean {
  if (!model) {
    return false
  }

  const normalized = model.trim().toLowerCase()
  return getOllamaAvailableModels().some(
    candidate => candidate.toLowerCase() === normalized,
  )
}

export function hasProjectOllamaConfiguration(): boolean {
  const env = getSettingsForSource('localSettings')?.env
  if (!env) {
    return false
  }

  return Boolean(env.OLLAMA_BASE_URL || env.OLLAMA_MODEL || env[OLLAMA_MODELS_ENV])
}

export function syncOllamaEnvironment(model: string | null | undefined): void {
  if (!isOllamaModel(model)) {
    delete process.env.CLAUDE_CODE_USE_OLLAMA
    return
  }

  process.env.CLAUDE_CODE_USE_OLLAMA = '1'
  delete process.env.CLAUDE_CODE_USE_OPENAI_COMPATIBLE
  process.env.OLLAMA_BASE_URL = getOllamaBaseURL()

  const apiKey = getOllamaApiKey()
  if (apiKey) {
    process.env.OLLAMA_API_KEY = apiKey
  } else {
    delete process.env.OLLAMA_API_KEY
  }

  if (model) {
    process.env.OLLAMA_MODEL = model.trim()
  }

  const smallFastModel = getConfiguredEnvValue('OLLAMA_SMALL_FAST_MODEL')
  if (smallFastModel) {
    process.env.OLLAMA_SMALL_FAST_MODEL = smallFastModel
  }
}

export async function withOllamaEnvironmentForModel<T>(
  model: string,
  callback: () => Promise<T>,
): Promise<T> {
  if (!isOllamaModel(model)) {
    return callback()
  }

  const snapshot = {
    CLAUDE_CODE_USE_OPENAI_COMPATIBLE:
      process.env.CLAUDE_CODE_USE_OPENAI_COMPATIBLE,
    CLAUDE_CODE_USE_OLLAMA: process.env.CLAUDE_CODE_USE_OLLAMA,
    OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL,
    OLLAMA_API_KEY: process.env.OLLAMA_API_KEY,
    OLLAMA_MODEL: process.env.OLLAMA_MODEL,
    OLLAMA_SMALL_FAST_MODEL: process.env.OLLAMA_SMALL_FAST_MODEL,
  }

  syncOllamaEnvironment(model)

  try {
    return await callback()
  } finally {
    restoreEnvValue(
      'CLAUDE_CODE_USE_OPENAI_COMPATIBLE',
      snapshot.CLAUDE_CODE_USE_OPENAI_COMPATIBLE,
    )
    restoreEnvValue('CLAUDE_CODE_USE_OLLAMA', snapshot.CLAUDE_CODE_USE_OLLAMA)
    restoreEnvValue('OLLAMA_BASE_URL', snapshot.OLLAMA_BASE_URL)
    restoreEnvValue('OLLAMA_API_KEY', snapshot.OLLAMA_API_KEY)
    restoreEnvValue('OLLAMA_MODEL', snapshot.OLLAMA_MODEL)
    restoreEnvValue('OLLAMA_SMALL_FAST_MODEL', snapshot.OLLAMA_SMALL_FAST_MODEL)
  }
}
