#!/usr/bin/env node

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { NdjsonTransport } from './transport.js';
import { envForModel, getPublicConfiguration, loadMicroClaudeConfig } from './config.js';
import {
  CAPABILITIES,
  ErrorCode,
  PROTOCOL_VERSION,
  ProtocolError,
  error,
  event,
  isRequest,
  ok,
  requireObject,
  requireString,
} from './protocol.js';
import { SessionStore } from './sessionStore.js';
import { LightweightEngine } from './engine.js';
import { MicroClaudeCliEngine } from './microClaudeCliEngine.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const argv = parseArgs(process.argv.slice(2));
const manifest = loadManifest();
const transport = new NdjsonTransport();
const sessions = new SessionStore();
const MICROCLAUDE_MANAGED_ENV_KEYS = [
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
  'CLAUDE_CODE_SIMPLE',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CONFIG_DIR',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'OPENAI_MODEL',
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'OLLAMA_MODEL',
  'OLLAMA_BASE_URL',
  'OLLAMA_API_KEY',
];
const config = loadMicroClaudeConfig(argv, message => transport.log(message));
const engine = createEngine(argv, config);
const activeTurns = new Map();
const bootedAt = Date.now();

transport.start(
  message => {
    void handleMessage(message);
  },
  parseError => {
    transport.send(error(null, ErrorCode.ParseError, parseError.message));
  },
);

transport.log(`ready protocol=${PROTOCOL_VERSION} pid=${process.pid}`);

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

async function handleMessage(message) {
  if (!isRequest(message)) {
    transport.send(error(null, ErrorCode.InvalidRequest, 'Expected a JSON-RPC 2.0 request'));
    return;
  }

  try {
    const result = await dispatch(message.method, requireObject(message.params), message.id);
    if (result !== NO_RESPONSE) {
      transport.send(ok(message.id, result));
    }
  } catch (err) {
    if (err instanceof ProtocolError) {
      transport.send(error(message.id, err.code, err.message, err.data));
      return;
    }

    transport.send(error(message.id, ErrorCode.InternalError, err?.message || 'Internal error'));
  }
}

async function dispatch(method, params) {
  switch (method) {
    case 'sidecar.ping':
      return {
        status: 'ok',
        pid: process.pid,
        uptimeMs: Date.now() - bootedAt,
        protocolVersion: PROTOCOL_VERSION,
        engine: engine.name,
        configuration: getPublicConfiguration(config),
        manifest,
      };

    case 'sidecar.getCapabilities':
      return {
        protocolVersion: PROTOCOL_VERSION,
        engine: engine.name,
        capabilities: CAPABILITIES,
        configuration: getPublicConfiguration(config),
      };

    case 'sidecar.getConfiguration':
      return getPublicConfiguration(config);

    case 'commands.list':
      return listCommands(params);

    case 'skills.list':
      return listSkills(params);

    case 'plugins.list':
      return listPlugins(params);

    case 'plugins.install':
      return installPlugin(params);

    case 'plugins.uninstall':
      return uninstallPlugin(params);

    case 'prompt.improve':
      return improvePrompt(params);

    case 'models.list':
      return listModels(params);

    case 'model.set':
      return setModel(params);

    case 'thinking.set':
      return setThinking(params);

    case 'effort.set':
      return setEffort(params);

    case 'modelSettings.get':
      return getModelSettings(params);

    case 'session.start':
      return startSession(params);

    case 'session.resume':
      return resumeSession(params);

    case 'session.cancel':
      return cancelSession(params);

    case 'session.dispose':
      return disposeSession(params);

    case 'message.send':
    case 'message.continue':
      return sendMessage(params);

    case 'permission.resolve':
      return resolvePermission(params);

    default:
      throw new ProtocolError(ErrorCode.MethodNotFound, `Unknown method: ${method}`);
  }
}

const CURATED_AVAILABLE_PLUGINS = Object.freeze([
  {
    id: 'frontend-design@claude-plugins-official',
    name: 'Frontend Design',
    description: 'Create polished frontend interfaces and visual systems.',
    marketplace: 'claude-plugins-official',
    status: 'available',
    actionCommand: '/plugin install frontend-design@claude-plugins-official',
  },
  {
    id: 'playwright@claude-plugins-official',
    name: 'Playwright',
    description: 'Verify browser UI with screenshots and traces.',
    marketplace: 'claude-plugins-official',
    status: 'available',
    actionCommand: '/plugin install playwright@claude-plugins-official',
  },
  {
    id: 'skill-creator@claude-plugins-official',
    name: 'Skill Creator',
    description: 'Create or refine reusable agent skills.',
    marketplace: 'claude-plugins-official',
    status: 'available',
    actionCommand: '/plugin install skill-creator@claude-plugins-official',
  },
  {
    id: 'openclaw-video-toolkit@openclaw-skills',
    name: 'OpenClaw Video Toolkit',
    description: 'Generate voiceovers, scenes, and Remotion videos from prompts.',
    marketplace: 'openclaw-skills',
    status: 'available',
    actionCommand: '/plugin install openclaw-video-toolkit@openclaw-skills',
  },
]);

function discoverInstalledSkills(workspace) {
  const roots = [
    { root: join(workspace, '.claude', 'skills'), source: 'Project' },
    { root: join(homedir(), '.claude', 'skills'), source: 'User' },
    { root: join(homedir(), '.codex', 'skills'), source: 'Codex' },
    { root: join(homedir(), '.codex', 'skills', '.system'), source: 'System' },
  ];

  for (const plugin of discoverInstalledPlugins()) {
    if (plugin.path) {
      roots.push({ root: join(plugin.path, 'skills'), source: plugin.name, origin: 'Plugin' });
    }
  }

  const seen = new Set();
  const skills = [];
  for (const rootInfo of roots) {
    for (const skill of readSkillRoot(rootInfo.root, rootInfo.source, rootInfo.origin)) {
      const key = skill.name.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      skills.push(skill);
    }
  }

  skills.sort((first, second) => first.name.localeCompare(second.name));
  return skills;
}

function readSkillRoot(root, source, origin = source) {
  if (!root || !existsSync(root)) {
    return [];
  }
  const skills = [];
  for (const entry of safeReadDir(root)) {
    if (!entry.isDirectory() || (entry.name.startsWith('.') && source !== 'System')) {
      continue;
    }
    const skillDir = join(root, entry.name);
    const skillFile = join(skillDir, 'SKILL.md');
    if (!existsSync(skillFile)) {
      continue;
    }
    const manifest = readSkillManifest(skillFile, entry.name);
    skills.push({
      id: manifest.name,
      name: manifest.name,
      description: manifest.description,
      source,
      origin,
      path: skillDir,
      status: 'installed',
    });
  }
  return skills;
}

function readSkillManifest(file, fallbackName) {
  const text = safeReadFile(file);
  const frontmatter = parseFrontmatter(text);
  const name = normalizeCatalogString(frontmatter.name) || fallbackName;
  const description = normalizeCatalogString(frontmatter.description) || firstBodyLine(text) || 'Installed skill';
  return { name, description };
}

function discoverInstalledPlugins() {
  const plugins = [...readClaudeInstalledPlugins(), ...readCodexPluginCache()];
  const seen = new Set();
  return plugins.filter(plugin => {
    const key = plugin.id.toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  }).sort((first, second) => first.name.localeCompare(second.name));
}

function readClaudeInstalledPlugins() {
  const file = join(homedir(), '.claude', 'plugins', 'installed_plugins.json');
  const parsed = safeReadJson(file);
  const plugins = parsed && typeof parsed === 'object' && parsed.plugins && typeof parsed.plugins === 'object' ? parsed.plugins : {};
  const result = [];
  for (const [id, installations] of Object.entries(plugins)) {
    const install = Array.isArray(installations) ? installations[0] : undefined;
    const [name, marketplace = 'local'] = id.split('@');
    const manifest = readPluginManifest(install?.installPath);
    result.push({
      id,
      name: manifest.name || name || id,
      description: manifest.description || (marketplace ? 'Installed from ' + marketplace : 'Installed plugin'),
      marketplace,
      source: install?.scope || marketplace,
      path: install?.installPath,
      version: install?.version,
      status: 'installed',
      actionCommand: 'Use ' + (manifest.name || name || id) + ' for this task.',
    });
  }
  return result;
}

function readCodexPluginCache() {
  const cacheRoot = join(homedir(), '.codex', 'plugins', 'cache');
  if (!existsSync(cacheRoot)) {
    return [];
  }
  const plugins = [];
  for (const provider of safeReadDir(cacheRoot)) {
    if (!provider.isDirectory()) {
      continue;
    }
    const providerRoot = join(cacheRoot, provider.name);
    for (const pluginEntry of safeReadDir(providerRoot)) {
      if (!pluginEntry.isDirectory()) {
        continue;
      }
      const pluginRoot = newestChildDirectory(join(providerRoot, pluginEntry.name)) ?? join(providerRoot, pluginEntry.name);
      const manifest = readPluginManifest(pluginRoot);
      if (!manifest.name && !manifest.description) {
        continue;
      }
      plugins.push({
        id: pluginEntry.name + '@' + provider.name,
        name: manifest.name || toTitleCase(pluginEntry.name),
        description: manifest.description || 'Installed from ' + provider.name,
        marketplace: provider.name,
        source: 'codex',
        path: pluginRoot,
        status: 'installed',
        actionCommand: 'Use ' + (manifest.name || pluginEntry.name) + ' for this task.',
      });
    }
  }
  return plugins;
}

function readPluginManifest(root) {
  if (!root) {
    return {};
  }
  for (const file of [join(root, '.codex-plugin', 'plugin.json'), join(root, '.claude-plugin', 'plugin.json'), join(root, 'plugin.json')]) {
    const parsed = safeReadJson(file);
    if (parsed && typeof parsed === 'object') {
      return {
        name: normalizeCatalogString(parsed.name) || normalizeCatalogString(parsed.displayName),
        description: normalizeCatalogString(parsed.description),
      };
    }
  }
  return {};
}

function newestChildDirectory(root) {
  if (!existsSync(root)) {
    return undefined;
  }
  const dirs = safeReadDir(root).filter(entry => entry.isDirectory());
  if (!dirs.length) {
    return undefined;
  }
  dirs.sort((first, second) => second.name.localeCompare(first.name));
  return join(root, dirs[0].name);
}

function parseFrontmatter(text) {
  if (!text.startsWith('---')) {
    return {};
  }
  const end = text.indexOf('\n---', 3);
  if (end === -1) {
    return {};
  }
  const yaml = text.slice(3, end).split(/\r?\n/);
  const result = {};
  for (const line of yaml) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (match) {
      result[match[1]] = match[2].replace(/^['"]|['"]$/g, '').trim();
    }
  }
  return result;
}

function firstBodyLine(text) {
  return text
    .replace(/^---[\s\S]*?\n---/, '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line && !line.startsWith('#'));
}

function safeReadDir(root) {
  try {
    return readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
}

function safeReadFile(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function safeReadJson(file) {
  try {
    if (!file || !existsSync(file) || !statSync(file).isFile()) {
      return undefined;
    }
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function normalizeCatalogString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function toTitleCase(value) {
  return String(value || '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, letter => letter.toUpperCase());
}

function startSession(params) {
  const session = sessions.start({
    sessionId: params.sessionId,
    workspace: params.workspace || argv.workspace || process.cwd(),
    userDataDir: params.userDataDir || argv.userDataDir || null,
    projectDataDir: params.projectDataDir || argv.projectDataDir || null,
    model: params.model || config.selectedModel || config.defaultModel,
    mode: params.mode || 'agent',
    autoApprove: params.autoApprove,
    permissionMode: params.permissionMode,
    endpoint: normalizeEndpoint(params),
  });

  emit(session.id, 'session.status', { status: session.status, session: publicSession(session) });
  return { session: publicSession(session) };
}

async function listCommands(params) {
  if (!engine.listCommands) {
    return { commands: [], engine: engine.name, refreshedAt: new Date().toISOString() };
  }

  const result = await engine.listCommands({
    cwd: typeof params.workspace === 'string' && params.workspace.trim()
      ? params.workspace.trim()
      : argv.workspace || process.cwd(),
    model: typeof params.model === 'string' && params.model.trim()
      ? params.model.trim()
      : config.selectedModel,
  });

  return {
    commands: Array.isArray(result?.commands) ? result.commands : [],
    engine: engine.name,
    refreshedAt: new Date().toISOString(),
  };
}

async function listSkills(params) {
  const workspace = typeof params.workspace === 'string' && params.workspace.trim()
    ? params.workspace.trim()
    : argv.workspace || process.cwd();
  return {
    skills: discoverInstalledSkills(workspace),
    engine: engine.name,
    refreshedAt: new Date().toISOString(),
  };
}

async function listPlugins(_params) {
  const installed = discoverInstalledPlugins();
  const installedIds = new Set(installed.map(plugin => plugin.id.toLowerCase()));
  return {
    installed,
    available: CURATED_AVAILABLE_PLUGINS.filter(plugin => !installedIds.has(plugin.id.toLowerCase())),
    engine: engine.name,
    refreshedAt: new Date().toISOString(),
  };
}

async function installPlugin(params) {
  const pluginId = typeof params.plugin === 'string' ? params.plugin.trim() : '';
  if (!pluginId) {
    throw new ProtocolError(ErrorCode.InvalidParams, 'Missing plugin id');
  }

  const available = CURATED_AVAILABLE_PLUGINS.find(plugin => plugin.id.toLowerCase() === pluginId.toLowerCase())
    ?? CURATED_AVAILABLE_PLUGINS.find(plugin => plugin.name.toLowerCase() === pluginId.toLowerCase());
  if (!available) {
    throw new ProtocolError(ErrorCode.InvalidParams, 'Unknown installable plugin: ' + pluginId);
  }

  const [name, marketplace = 'local'] = available.id.split('@');
  const pluginRoot = join(homedir(), '.codex', 'plugins', 'cache', marketplace, name, '1.0.0');
  const manifestDir = join(pluginRoot, '.codex-plugin');
  await mkdir(manifestDir, { recursive: true });
  await writeFile(join(manifestDir, 'plugin.json'), JSON.stringify({
    name: available.name,
    displayName: available.name,
    version: available.version || '1.0.0',
    description: available.description
  }, null, 2));

  const installed = discoverInstalledPlugins();
  const plugin = installed.find(item => item.id.toLowerCase() === available.id.toLowerCase()) ?? {
    ...available,
    status: 'installed',
    path: pluginRoot,
    actionCommand: 'Use ' + available.name + ' for this task.'
  };
  const installedIds = new Set(installed.map(item => item.id.toLowerCase()));
  const nextInstalled = installedIds.has(plugin.id.toLowerCase()) ? installed : [...installed, plugin];
  const nextIds = new Set(nextInstalled.map(item => item.id.toLowerCase()));
  return {
    plugin,
    installed: nextInstalled,
    available: CURATED_AVAILABLE_PLUGINS.filter(item => !nextIds.has(item.id.toLowerCase())),
    engine: engine.name,
    refreshedAt: new Date().toISOString(),
    message: 'Installed ' + available.name
  };
}

async function uninstallPlugin(params) {
  const pluginId = typeof params.plugin === 'string' ? params.plugin.trim() : '';
  if (!pluginId) {
    throw new ProtocolError(ErrorCode.InvalidParams, 'Missing plugin id');
  }

  const installed = discoverInstalledPlugins();
  const plugin = installed.find(item => item.id.toLowerCase() === pluginId.toLowerCase())
    ?? installed.find(item => item.name.toLowerCase() === pluginId.toLowerCase());
  if (!plugin) {
    throw new ProtocolError(ErrorCode.InvalidParams, 'Plugin is not installed: ' + pluginId);
  }

  const cacheRoot = join(homedir(), '.codex', 'plugins', 'cache');
  const [name, marketplace = plugin.marketplace || 'local'] = plugin.id.split('@');
  const codexPluginDir = join(cacheRoot, marketplace, name);
  if (isPathInside(codexPluginDir, cacheRoot) && existsSync(codexPluginDir)) {
    await rm(codexPluginDir, { recursive: true, force: true });
  } else {
    await removeClaudeInstalledPlugin(plugin.id);
  }

  const nextInstalled = discoverInstalledPlugins();
  const nextIds = new Set(nextInstalled.map(item => item.id.toLowerCase()));
  return {
    plugin: plugin.id,
    installed: nextInstalled,
    available: CURATED_AVAILABLE_PLUGINS.filter(item => !nextIds.has(item.id.toLowerCase())),
    engine: engine.name,
    refreshedAt: new Date().toISOString(),
    message: 'Uninstalled ' + plugin.name
  };
}

async function removeClaudeInstalledPlugin(pluginId) {
  const file = join(homedir(), '.claude', 'plugins', 'installed_plugins.json');
  const parsed = safeReadJson(file);
  if (!parsed || typeof parsed !== 'object' || !parsed.plugins || typeof parsed.plugins !== 'object') {
    return;
  }
  if (!Object.prototype.hasOwnProperty.call(parsed.plugins, pluginId)) {
    return;
  }
  delete parsed.plugins[pluginId];
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(parsed, null, 2));
}

function isPathInside(child, parent) {
  const resolvedParent = resolve(parent);
  const resolvedChild = resolve(child);
  const relative = resolvedChild.slice(resolvedParent.length);
  return resolvedChild !== resolvedParent
    && resolvedChild.toLowerCase().startsWith(resolvedParent.toLowerCase())
    && /^[\\/]/.test(relative)
    && !relative.split(/[\\/]+/).includes('..');
}
async function listModels(params) {
  if (!engine.listModels) {
    return { models: [], engine: engine.name, refreshedAt: new Date().toISOString() };
  }

  const result = await engine.listModels({
    cwd: typeof params.workspace === 'string' && params.workspace.trim()
      ? params.workspace.trim()
      : argv.workspace || process.cwd(),
    model: typeof params.model === 'string' && params.model.trim()
      ? params.model.trim()
      : config.selectedModel,
  });

  return {
    models: Array.isArray(result?.models) ? result.models : [],
    fastModeState: result?.fastModeState,
    account: result?.account,
    outputStyle: result?.outputStyle,
    availableOutputStyles: Array.isArray(result?.availableOutputStyles) ? result.availableOutputStyles : [],
    engine: engine.name,
    refreshedAt: new Date().toISOString(),
  };
}

async function setModel(params) {
  const { sessionId, session } = requireReadySession(params);
  const model = normalizeOptionalString(params.model) ?? 'default';
  const result = await engine.setModel({
    session,
    model,
    emit: (name, payload) => emit(sessionId, name, payload),
  });
  const updated = sessions.updateModel(sessionId, result?.model || model);
  emit(sessionId, 'session.status', { status: updated?.status ?? 'ready', session: publicSession(updated ?? session) });
  return {
    ...result,
    sessionId,
    session: publicSession(updated ?? session),
  };
}

async function setThinking(params) {
  const { sessionId, session } = requireReadySession(params);
  const maxThinkingTokens = normalizeMaxThinkingTokens(params);
  const result = await engine.setThinking({
    session,
    maxThinkingTokens,
    emit: (name, payload) => emit(sessionId, name, payload),
  });
  return { ...result, sessionId };
}

async function setEffort(params) {
  const { sessionId, session } = requireReadySession(params);
  const effort = normalizeEffortParam(params.effort);
  const result = await engine.setEffort({
    session,
    effort,
    emit: (name, payload) => emit(sessionId, name, payload),
  });
  return { ...result, sessionId };
}

async function getModelSettings(params) {
  const { sessionId, session } = requireReadySession(params);
  const result = await engine.getSettings({
    session,
    emit: (name, payload) => emit(sessionId, name, payload),
  });
  return { ...result, sessionId };
}

async function improvePrompt(params) {
  const prompt = typeof params.prompt === 'string' ? params.prompt : '';
  const mode = normalizeTaskCreationMode(params.mode);
  const context = normalizeImprovePromptContext(params.context);
  const workspace = normalizeOptionalString(params.workspace) ?? argv.workspace ?? process.cwd();
  const model = normalizeOptionalString(params.model) ?? config.selectedModel;
  const instruction = buildImprovePromptInstruction({ prompt, mode, context, workspace });
  const endpoint = normalizeEndpoint(params) ?? undefined;

  try {
    const result = await engine.improvePrompt?.({
      prompt,
      mode,
      instruction,
      workspace,
      model,
      endpoint,
    });
    const improved = cleanImprovedPrompt(result?.prompt ?? result?.text ?? '');
    if (improved) {
      return {
        prompt: improved,
        model,
        engine: engine.name,
        fallback: Boolean(result?.fallback),
        refreshedAt: new Date().toISOString(),
      };
    }
  } catch (err) {
    transport.log(`WARNING prompt.improve failed: ${err?.message || err}`);
  }

  return {
    prompt: fallbackImprovePrompt(prompt, mode),
    model,
    engine: engine.name,
    fallback: true,
    refreshedAt: new Date().toISOString(),
  };
}

function requireReadySession(params) {
  const sessionId = requireString(params.sessionId, 'sessionId');
  const session = sessions.get(sessionId);
  if (!session) {
    throw new ProtocolError(ErrorCode.SessionNotFound, `Session not found: ${sessionId}`);
  }
  if (activeTurns.has(sessionId)) {
    throw new ProtocolError(ErrorCode.SessionBusy, `Session is busy: ${sessionId}`);
  }
  return { sessionId, session };
}

// Build a per-session endpoint override from start params, or null when none was supplied.
function normalizeEndpoint(params) {
  const baseUrl = typeof params.baseUrl === 'string' && params.baseUrl.trim() ? params.baseUrl.trim() : undefined;
  const apiKey = typeof params.apiKey === 'string' && params.apiKey.trim() ? params.apiKey.trim() : undefined;
  return baseUrl || apiKey ? { baseUrl, apiKey } : null;
}

// Strip secrets (endpoint.apiKey) before a session is echoed back over the protocol.
function publicSession(session) {
  if (!session) {
    return session;
  }
  const { endpoint, ...rest } = session;
  return endpoint ? { ...rest, endpoint: { baseUrl: endpoint.baseUrl } } : rest;
}

function resumeSession(params) {
  const sessionId = requireString(params.sessionId, 'sessionId');
  const existing = sessions.get(sessionId);
  if (existing) {
    emit(existing.id, 'session.status', { status: existing.status, session: publicSession(existing) });
    return { session: publicSession(existing), resumed: true };
  }

  // Not in this sidecar's memory (e.g. after an IDE restart). Recreate the
  // session record and flag it so the CLI engine starts with --resume, letting
  // microClaude replay the persisted .jsonl transcript for this session id.
  const session = sessions.start({ ...params, sessionId, endpoint: normalizeEndpoint(params), resume: true });
  emit(session.id, 'session.status', { status: session.status, session: publicSession(session) });
  return { session: publicSession(session), resumed: true };
}

function sendMessage(params) {
  const sessionId = requireString(params.sessionId, 'sessionId');
  const session = sessions.get(sessionId);
  if (!session) {
    throw new ProtocolError(ErrorCode.SessionNotFound, `Session not found: ${sessionId}`);
  }

  if (activeTurns.has(sessionId)) {
    throw new ProtocolError(ErrorCode.SessionBusy, `Session is busy: ${sessionId}`);
  }

  const prompt = normalizePrompt(params);
  const content = normalizeContent(params);
  if (params.model) {
    sessions.updateModel(sessionId, params.model);
    session.model = params.model;
  }
  if (typeof params.mode === 'string' && params.mode.trim() && params.mode !== session.mode) {
    const previousMode = session.mode;
    const nextMode = params.mode.trim();
    sessions.updateMode(sessionId, nextMode);
    session.mode = nextMode;
    engine.resetSession?.(sessionId, { reason: 'modeChanged', previousMode, nextMode });
    emit(sessionId, 'session.status', { status: session.status, session: publicSession(session), modeChanged: true });
  }
  const controller = new AbortController();
  activeTurns.set(sessionId, controller);
  sessions.updateStatus(sessionId, 'busy');
  emit(sessionId, 'session.status', { status: 'busy' });

  void engine
    .sendMessage({
      session,
      prompt,
      content,
      signal: controller.signal,
      emit: (name, payload) => emit(sessionId, name, payload),
    })
    .then(() => {
      sessions.updateStatus(sessionId, 'ready');
      emit(sessionId, 'session.status', { status: 'ready' });
    })
    .catch(err => {
      if (err?.name === 'AbortError') {
        sessions.updateStatus(sessionId, 'ready');
        emit(sessionId, 'session.status', { status: 'ready', cancelled: true });
        return;
      }

      sessions.updateStatus(sessionId, 'ready');
      emit(sessionId, 'session.error', { message: err?.message || 'Unknown engine error' });
      emit(sessionId, 'session.status', { status: 'ready' });
    })
    .finally(() => {
      activeTurns.delete(sessionId);
    });

  return { accepted: true, sessionId };
}

function cancelSession(params) {
  const sessionId = requireString(params.sessionId, 'sessionId');
  const controller = activeTurns.get(sessionId);
  if (!controller) {
    return { cancelled: Boolean(engine.cancelSession?.(sessionId)), sessionId };
  }

  controller.abort();
  activeTurns.delete(sessionId);
  sessions.updateStatus(sessionId, 'ready');
  emit(sessionId, 'session.status', { status: 'ready', cancelled: true });
  return { cancelled: true, sessionId };
}

function disposeSession(params) {
  const sessionId = requireString(params.sessionId, 'sessionId');
  const controller = activeTurns.get(sessionId);
  if (controller) {
    controller.abort();
    activeTurns.delete(sessionId);
  }

  engine.disposeSession?.(sessionId);
  const disposed = sessions.dispose(sessionId);
  return { disposed, sessionId };
}

function resolvePermission(params) {
  if (!engine.resolvePermission) {
    return { resolved: false, reason: 'active engine does not support permission resolution' };
  }

  return engine.resolvePermission(params);
}

function emit(sessionId, name, payload) {
  transport.send(event(sessionId, name, payload));
}

function normalizePrompt(params) {
  if (typeof params.prompt === 'string') {
    return params.prompt;
  }

  if (typeof params.text === 'string') {
    return params.text;
  }

  if (Array.isArray(params.content)) {
    return params.content
      .map(block => (block && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
      .filter(Boolean)
      .join('\n');
  }

  if (Array.isArray(params.messages)) {
    return params.messages
      .map(message => {
        if (typeof message === 'string') {
          return message;
        }
        if (message && typeof message.content === 'string') {
          return message.content;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  return '';
}

// Returns sanitized Anthropic content blocks when the caller sent structured
// rich input (e.g. text + images). Returns null when only a plain prompt was
// provided, in which case the engine falls back to a string message body.
function normalizeContent(params) {
  if (!Array.isArray(params.content)) {
    return null;
  }

  const blocks = [];
  for (const block of params.content) {
    if (!block || typeof block !== 'object') {
      continue;
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      blocks.push({ type: 'text', text: block.text });
    } else if (block.type === 'image' && block.source && block.source.type === 'base64'
      && typeof block.source.media_type === 'string' && typeof block.source.data === 'string') {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: block.source.media_type, data: block.source.data },
      });
    }
  }

  return blocks.length ? blocks : null;
}

function normalizeOptionalString(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeTaskCreationMode(value) {
  return normalizeOptionalString(value) === 'working' ? 'working' : 'coding';
}

function normalizeImprovePromptContext(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map(item => {
      if (!item || typeof item !== 'object') {
        return null;
      }
      const path = normalizeOptionalString(item.path);
      if (!path) {
        return null;
      }
      const ranges = Array.isArray(item.selectionRanges)
        ? item.selectionRanges
          .map(normalizeImprovePromptRange)
          .filter(Boolean)
        : [];
      return {
        path,
        ...(normalizeOptionalString(item.label) ? { label: normalizeOptionalString(item.label) } : {}),
        ...(normalizeOptionalString(item.source) ? { source: normalizeOptionalString(item.source) } : {}),
        ...(finitePositiveInteger(item.selectionLineCount) ? { selectionLineCount: finitePositiveInteger(item.selectionLineCount) } : {}),
        ...(finitePositiveInteger(item.selectedTextLength) ? { selectedTextLength: finitePositiveInteger(item.selectedTextLength) } : {}),
        ...(ranges.length ? { selectionRanges: ranges } : {}),
      };
    })
    .filter(Boolean)
    .slice(0, 12);
}

function normalizeImprovePromptRange(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const startLineNumber = finitePositiveInteger(value.startLineNumber);
  const endLineNumber = finitePositiveInteger(value.endLineNumber);
  if (!startLineNumber || !endLineNumber) {
    return null;
  }
  return {
    startLineNumber: Math.min(startLineNumber, endLineNumber),
    endLineNumber: Math.max(startLineNumber, endLineNumber),
  };
}

function finitePositiveInteger(value) {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(number) && number > 0 ? Math.round(number) : undefined;
}

function buildImprovePromptInstruction({ prompt, mode, context, workspace }) {
  const base = prompt.trim() || (mode === 'working'
    ? 'Help me complete this workplace task.'
    : 'Help me complete this coding task.');
  const lines = [
    'You are improving a prompt for microWorker, an AI coding and work assistant.',
    'Rewrite the user draft into one clear, actionable prompt for the agent.',
    'Return only the improved prompt text. Do not include markdown fences, commentary, headings, or alternatives.',
    'Preserve the user language, intent, names, constraints, and file references.',
    mode === 'working'
      ? 'Mode: working. Emphasize outcome, constraints, deliverables, and concrete next actions.'
      : 'Mode: coding. Emphasize files to inspect, implementation scope, existing style, tests, and verification.',
    `Workspace: ${workspace}`,
    '',
  ];

  if (context.length) {
    lines.push('Available file context:', ...context.map(item => `- ${describeImprovePromptContext(item)}`), '');
  }

  lines.push('User draft:', base);
  return lines.join('\n');
}

function describeImprovePromptContext(item) {
  const details = [item.source || 'file'];
  if (item.selectionLineCount && item.selectionRanges?.length) {
    const ranges = item.selectionRanges
      .map(range => range.startLineNumber === range.endLineNumber ? String(range.startLineNumber) : `${range.startLineNumber}-${range.endLineNumber}`)
      .join(', ');
    details.push(`selected ${item.selectionLineCount} lines: ${ranges}`);
  }
  const label = item.label && item.label !== item.path ? ` (${item.label})` : '';
  return `${item.path}${label} - ${details.join(', ')}`;
}

function cleanImprovedPrompt(value) {
  let text = normalizeOptionalString(value) ?? '';
  if (!text) {
    return '';
  }
  text = text.replace(/^```[a-zA-Z0-9_-]*\s*/, '').replace(/```$/, '').trim();
  text = text.replace(/^(?:improved prompt|prompt)\s*[:：]\s*/i, '').trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

function fallbackImprovePrompt(prompt, mode) {
  const base = prompt.trim() || (mode === 'working'
    ? 'Help me complete this workplace task.'
    : 'Help me complete this coding task.');
  if (/Please work in this structure:/i.test(base)) {
    return base;
  }
  const steps = mode === 'working'
    ? [
      'Clarify the outcome and constraints first.',
      'Use the current workspace context when relevant.',
      'Produce a concise deliverable with concrete next actions.',
    ]
    : [
      'Inspect the relevant files before editing.',
      'Make focused changes that match the existing code style.',
      'Run the smallest useful verification and summarize any remaining risk.',
    ];
  return [base, '', 'Please work in this structure:', ...steps.map((step, index) => `${index + 1}. ${step}`)].join('\n');
}

function normalizeMaxThinkingTokens(params) {
  if (Object.hasOwn(params, 'maxThinkingTokens')) {
    const value = params.maxThinkingTokens;
    if (value === null) {
      return null;
    }
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return Math.round(value);
    }
    throw new ProtocolError(ErrorCode.InvalidParams, 'maxThinkingTokens must be null or a non-negative number');
  }

  if (params.enabled === false) {
    return 0;
  }

  return null;
}

function normalizeEffortParam(value) {
  const normalized = normalizeOptionalString(value)?.toLowerCase().replace(/^extra-high$/, 'xhigh');
  if (
    normalized === 'auto' ||
    normalized === 'low' ||
    normalized === 'medium' ||
    normalized === 'high' ||
    normalized === 'xhigh' ||
    normalized === 'max' ||
    normalized === 'ultracode'
  ) {
    return normalized;
  }

  throw new ProtocolError(ErrorCode.InvalidParams, 'effort must be one of auto, low, medium, high, xhigh, max, ultracode');
}

function parseArgs(args) {
  const parsed = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      continue;
    }

    const key = toCamelCase(arg.slice(2));
    const next = args[index + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
      continue;
    }

    parsed[key] = next;
    index += 1;
  }

  return parsed;
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function loadManifest() {
  const manifestPath = resolve(__dirname, '..', 'manifest.json');
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return {
      name: 'microclaude',
      version: '0.0.0-dev',
      protocolVersion: PROTOCOL_VERSION,
      capabilities: CAPABILITIES,
    };
  }
}

function shutdown() {
  for (const controller of activeTurns.values()) {
    controller.abort();
  }
  engine.shutdown?.();

  process.exit(0);
}

const NO_RESPONSE = Symbol('NO_RESPONSE');

function createEngine(args, config) {
  if (args.engine === 'microclaude') {
    const cliPath = args.microclaudeCli || resolve(__dirname, '..', '..', '..', 'microClaude', 'cli.js');
    const runtimePath = args.microclaudeRuntime || process.execPath;

    if (!existsSync(cliPath)) {
      transport.log(
        `WARNING engine=microclaude requested but CLI not found at ${cliPath}; falling back to lightweight engine`,
      );
      return Object.assign(new LightweightEngine(), { name: 'lightweight', degraded: true, degradedReason: `microClaude CLI not found: ${cliPath}` });
    }

    const baseEnv = envForModel(config, config.selectedModel);
    const env = createMicroClaudeEnv(process.env, baseEnv, {
      MICROIDE_MICROCLAUDE_CONFIG: config.configPath,
      MICROIDE_MICROCLAUDE_DEFAULT_CONFIG: config.defaultConfigPath,
    });

    return Object.assign(
      new MicroClaudeCliEngine({
        cliPath,
        runtimePath,
        env,
        envForModel: model => envForModel(config, model || config.selectedModel),
        extraArgs: parseCsvArg(args.microclaudeArg),
      }),
      { name: 'microclaude' },
    );
  }

  return Object.assign(new LightweightEngine(), { name: 'lightweight' });
}

function createMicroClaudeEnv(parentEnv, configuredEnv, extraEnv) {
  const env = { ...parentEnv };
  for (const key of MICROCLAUDE_MANAGED_ENV_KEYS) {
    delete env[key];
  }

  for (const source of [configuredEnv, extraEnv]) {
    for (const [key, value] of Object.entries(source ?? {})) {
      if (value !== undefined && value !== null) {
        env[key] = String(value);
      }
    }
  }

  return env;
}

function parseCsvArg(value) {
  if (!value) {
    return [];
  }

  return String(value)
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);
}
