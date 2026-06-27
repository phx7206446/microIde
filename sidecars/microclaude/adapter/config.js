import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ENV_KEYS = new Set([
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_CUSTOM_HEADERS',
  'API_TIMEOUT_MS',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_OPENAI_COMPATIBLE',
  'CLAUDE_CODE_USE_OLLAMA',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_SIMPLE',
  'CLAUDE_CONFIG_DIR',
  'OPENAI_MODEL',
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'OLLAMA_MODEL',
  'OLLAMA_BASE_URL',
  'OLLAMA_API_KEY',
]);

const DEFAULT_MODEL = 'MiniMax-M3';

export function loadMicroClaudeConfig(args = {}, logger = () => undefined) {
  const configPath = resolveConfigPath(args);
  const defaultConfigPath = resolveDefaultConfigPath(args);
  const raw = mergeConfig(
    readConfig(defaultConfigPath, logger),
    readConfig(configPath, logger),
  );
  const env = normalizeEnv(raw);
  const defaultModel = normalizeString(raw.defaultModel) ?? normalizeString(env.ANTHROPIC_MODEL) ?? DEFAULT_MODEL;
  const models = normalizeModels(raw.models, defaultModel, env);
  const selectedModel = models.some(model => model.id === defaultModel) ? defaultModel : models[0].id;

  if (!env.ANTHROPIC_MODEL) {
    env.ANTHROPIC_MODEL = selectedModel;
  }
  env.ANTHROPIC_DEFAULT_SONNET_MODEL ??= selectedModel;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL ??= selectedModel;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL ??= selectedModel;
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ??= '1';
  env.CLAUDE_CODE_SIMPLE ??= '1';

  if (!env.CLAUDE_CONFIG_DIR && args.projectDataDir) {
    env.CLAUDE_CONFIG_DIR = join(args.projectDataDir, 'claude');
  }

  return {
    configPath,
    defaultConfigPath,
    defaultModel: selectedModel,
    selectedModel,
    models,
    env,
  };
}

export function getPublicConfiguration(config) {
  const selectedModel = config.selectedModel || config.defaultModel || DEFAULT_MODEL;
  const baseUrl = config.env?.ANTHROPIC_BASE_URL || config.models?.find(model => model.id === selectedModel)?.baseUrl;

  return {
    configPath: config.configPath,
    defaultModel: config.defaultModel || selectedModel,
    selectedModel,
    baseUrl,
    models: (config.models?.length ? config.models : [createModel(selectedModel, config.env)]).map(model => ({
      id: model.id,
      label: model.label || model.id,
      provider: model.provider,
      baseUrl: model.baseUrl || baseUrl,
      description: model.description,
      ...(typeof model.contextWindow === 'number' ? { contextWindow: model.contextWindow } : {}),
      ...(typeof model.weight === 'number' ? { weight: model.weight } : {}),
      ...(model.tier ? { tier: model.tier } : {}),
      ...(model.custom ? { custom: true } : {}),
    })),
  };
}

export function envForModel(config, modelId) {
  const model = config.models.find(candidate => candidate.id === modelId) ?? config.models[0] ?? createModel(modelId || DEFAULT_MODEL, config.env);
  const env = {
    ...config.env,
    ...normalizeEnv(model),
  };

  if (!env.ANTHROPIC_BASE_URL && model.baseUrl) {
    env.ANTHROPIC_BASE_URL = model.baseUrl;
  }
  env.ANTHROPIC_MODEL = model.id;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL ??= model.id;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL ??= model.id;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL ??= model.id;
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ??= '1';
  env.CLAUDE_CODE_SIMPLE ??= '1';

  return env;
}

function resolveConfigPath(args) {
  const explicit = args.config || process.env.MICROIDE_MICROCLAUDE_CONFIG;
  return explicit ? resolve(String(explicit)) : undefined;
}

function resolveDefaultConfigPath(args) {
  const explicit = args.defaultConfig || process.env.MICROIDE_MICROCLAUDE_DEFAULT_CONFIG;
  return explicit ? resolve(String(explicit)) : undefined;
}

function readConfig(configPath, logger) {
  if (!configPath || !existsSync(configPath)) {
    return {};
  }

  try {
    return JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    logger(`failed to read config ${configPath}: ${error?.message || error}`);
    return {};
  }
}

function mergeConfig(base, override) {
  return {
    ...base,
    ...override,
    env: {
      ...firstObject(base.env),
      ...firstObject(override.env),
    },
  };
}

function firstObject(...values) {
  return values.find(value => value && typeof value === 'object' && !Array.isArray(value)) ?? {};
}

function normalizeEnv(source) {
  const env = {};
  const nested = source?.env && typeof source.env === 'object' && !Array.isArray(source.env) ? source.env : {};

  for (const candidate of [source, nested]) {
    for (const [key, value] of Object.entries(candidate ?? {})) {
      if (ENV_KEYS.has(key) && value !== undefined && value !== null) {
        env[key] = String(value);
      }
    }
  }

  return env;
}

function normalizeModels(value, defaultModel, env) {
  if (!Array.isArray(value) || value.length === 0) {
    return [createModel(defaultModel, env)];
  }

  const models = value
    .map(model => {
      if (typeof model === 'string') {
        return createModel(model, env);
      }
      if (!model || typeof model !== 'object') {
        return undefined;
      }
      const id = normalizeString(model.id) ?? normalizeString(model.name);
      if (!id) {
        return undefined;
      }
      return {
        id,
        label: normalizeString(model.label) ?? id,
        provider: normalizeString(model.provider),
        baseUrl: normalizeString(model.baseUrl) ?? normalizeString(model.ANTHROPIC_BASE_URL) ?? normalizeString(model.env?.ANTHROPIC_BASE_URL) ?? env.ANTHROPIC_BASE_URL,
        description: normalizeString(model.description),
        contextWindow: normalizePositiveNumber(model.contextWindow) ?? normalizePositiveNumber(model.contextWindowTokens) ?? normalizePositiveNumber(model.maxContextTokens),
        weight: typeof model.weight === 'number' ? model.weight : undefined,
        tier: normalizeString(model.tier),
        custom: model.custom === true ? true : undefined,
        env: normalizeEnv(model),
      };
    })
    .filter(Boolean);

  return models.length ? models : [createModel(defaultModel, env)];
}

function createModel(id, env) {
  return {
    id,
    label: id,
    provider: env?.ANTHROPIC_BASE_URL?.includes('minimaxi') ? 'MiniMax' : undefined,
    baseUrl: env?.ANTHROPIC_BASE_URL,
    env: {},
  };
}

function normalizeString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizePositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
}
