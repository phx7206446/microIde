import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { MicroClaudeMessageMapper } from './microClaudeMessageMapper.js';

const MAX_STDERR_LINES = 40;
const CONTROL_REQUEST_TIMEOUT_MS = 15000;
const PROMPT_IMPROVE_TIMEOUT_MS = 60000;
const TURN_CANCEL_GRACE_MS = 5000;
const TURN_CANCEL_KILL_GRACE_MS = 2500;
const ESCAPE_KEY = '\x1b';
const AGENT_TEAM_ENV = Object.freeze({
  CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
  CLAUDE_CODE_ENABLE_TASKS: '1',
});

export class MicroClaudeCliEngine {
  #handles = new Map();
  #pendingPermissions = new Map();
  #pendingControlRequests = new Map();

  constructor(options = {}) {
    this.cliPath = options.cliPath;
    this.runtimePath = options.runtimePath || process.execPath;
    this.extraArgs = options.extraArgs || [];
    this.env = options.env || process.env;
    this.envForModel = options.envForModel || (() => ({}));
  }

  async listCommands({ cwd, model } = {}) {
    const response = await this.#discoverInitialization({ cwd, model, label: 'slash commands' });
    return { commands: normalizeSlashCommands(response?.commands) };
  }

  async listModels({ cwd, model } = {}) {
    const response = await this.#discoverInitialization({ cwd, model, label: 'models' });
    return {
      models: normalizeModelOptions(response?.models),
      fastModeState: normalizeFastModeState(response?.fast_mode_state),
      account: normalizePlainObject(response?.account),
      outputStyle: typeof response?.output_style === 'string' ? response.output_style : undefined,
      availableOutputStyles: Array.isArray(response?.available_output_styles)
        ? response.available_output_styles.filter(item => typeof item === 'string')
        : [],
    };
  }

  async setModel({ session, model, emit }) {
    await this.sendControlRequest({
      session,
      emit,
      request: {
        subtype: 'set_model',
        ...(model && model !== 'default' ? { model } : {}),
      },
    });
    const settings = await this.getSettings({ session, emit });
    return {
      requestedModel: model || 'default',
      model: settings.applied?.model || model || 'default',
      settings,
    };
  }

  async setThinking({ session, maxThinkingTokens, emit }) {
    await this.sendControlRequest({
      session,
      emit,
      request: {
        subtype: 'set_max_thinking_tokens',
        max_thinking_tokens: maxThinkingTokens,
      },
    });
    return { thinking: normalizeThinkingState(maxThinkingTokens) };
  }

  async setEffort({ session, effort, emit }) {
    const response = await this.sendControlRequest({
      session,
      emit,
      request: {
        subtype: 'set_effort',
        effort,
      },
    });
    return {
      effort: normalizeEffortValue(response?.effort) ?? normalizeEffortValue(effort) ?? 'auto',
      applied: normalizeAppliedSettings(response?.applied),
    };
  }

  async getSettings({ session, emit }) {
    const response = await this.sendControlRequest({
      session,
      emit,
      request: { subtype: 'get_settings' },
    });
    return normalizeRuntimeSettings(response);
  }

  async applyFlagSettings({ session, settings, emit }) {
    const response = await this.sendControlRequest({
      session,
      emit,
      request: {
        subtype: 'apply_flag_settings',
        settings: settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {},
      },
    });
    return { response };
  }

  async sendControlRequest({ session, request, emit = () => undefined, timeoutMs = CONTROL_REQUEST_TIMEOUT_MS }) {
    const handle = this.#getOrStart(session, emit);
    if (handle.activeTurn) {
      throw new Error(`microClaude session is busy: ${session.id}`);
    }

    const requestId = `microide-control-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pendingControlRequests.delete(requestId);
        reject(new Error(`Timed out waiting for microClaude control response: ${request.subtype}`));
      }, timeoutMs);

      this.#pendingControlRequests.set(requestId, {
        handle,
        resolve,
        reject,
        timeout,
        subtype: request.subtype,
      });

      writeJson(handle.child.stdin, {
        type: 'control_request',
        request_id: requestId,
        request,
      });
    });
  }

  async #discoverInitialization({ cwd, model, label }) {
    if (!this.cliPath) {
      throw new Error(`microClaude CLI path is required for ${label} discovery`);
    }
    if (!existsSync(this.cliPath)) {
      throw new Error(`microClaude CLI was not found: ${this.cliPath}`);
    }
    if (!this.runtimePath || !existsSync(this.runtimePath)) {
      throw new Error(`microClaude runtime was not found: ${this.runtimePath || '<empty>'}`);
    }

    const requestId = `microide-initialize-${randomUUID()}`;
    const profile = createSessionProfile();
    const args = [
      this.cliPath,
      '--print',
      ...profile.args,
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-prompt-tool',
      'stdio',
      ...filterExtraArgs(this.extraArgs, profile),
    ];

    const child = spawn(this.runtimePath, args, {
      cwd: cwd || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: createEngineEnv(
        this.env,
        this.envForModel(model),
        profile.env,
        {
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          FORCE_COLOR: '0',
          NO_COLOR: '1',
        },
      ),
      windowsHide: true,
    });

    return new Promise((resolve, reject) => {
      let settled = false;
      const stderrLines = [];
      const timeout = setTimeout(() => {
        settle(false, new Error(withStderr(`Timed out while discovering microClaude ${label}`, stderrLines)));
      }, CONTROL_REQUEST_TIMEOUT_MS);

      const settle = (ok, value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        if (!child.killed) {
          child.kill();
        }
        if (ok) {
          resolve(value);
        } else {
          reject(value);
        }
      };

      child.on('error', error => settle(false, error));
      child.on('close', (code, signal) => {
        if (!settled) {
          const message = signal
            ? `microClaude ${label} discovery exited with signal ${signal}`
            : `microClaude ${label} discovery exited with code ${code}`;
          settle(false, new Error(withStderr(message, stderrLines)));
        }
      });

      createInterface({ input: child.stderr }).on('line', line => {
        pushRing(stderrLines, line, MAX_STDERR_LINES);
      });

      createInterface({ input: child.stdout }).on('line', line => {
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          return;
        }

        const response = parsed?.type === 'control_response' ? parsed.response : undefined;
        if (response?.request_id !== requestId) {
          return;
        }

        if (response.subtype !== 'success') {
          settle(false, new Error(response.error || `microClaude ${label} discovery failed`));
          return;
        }

        settle(true, response.response ?? {});
      });

      writeJson(child.stdin, {
        type: 'control_request',
        request_id: requestId,
        request: { subtype: 'initialize' },
      });
    });
  }

  async improvePrompt({ instruction, workspace, model, endpoint, signal } = {}) {
    if (!this.cliPath) {
      throw new Error('microClaude CLI path is required for prompt improvement');
    }
    if (!existsSync(this.cliPath)) {
      throw new Error(`microClaude CLI was not found: ${this.cliPath}`);
    }
    if (!this.runtimePath || !existsSync(this.runtimePath)) {
      throw new Error(`microClaude runtime was not found: ${this.runtimePath || '<empty>'}`);
    }

    const sessionId = `microide-improve-${randomUUID()}`;
    const mapper = new MicroClaudeMessageMapper();
    const profile = createSessionProfile('ask');
    const args = [
      this.cliPath,
      '--print',
      ...profile.args,
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-prompt-tool',
      'stdio',
      '--session-id',
      sessionId,
      ...filterExtraArgs(this.extraArgs, profile),
    ];

    const child = spawn(this.runtimePath, args, {
      cwd: workspace || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: createEngineEnv(
        this.env,
        this.envForModel(model),
        endpointEnv(endpoint),
        profile.env,
        {
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          FORCE_COLOR: '0',
          NO_COLOR: '1',
        },
      ),
      windowsHide: true,
    });

    return new Promise((resolve, reject) => {
      let settled = false;
      let assistantText = '';
      let deltaText = '';
      const stderrLines = [];
      let timeout;

      const settle = (ok, value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
        if (!child.killed) {
          child.kill();
        }
        if (ok) {
          resolve(value);
        } else {
          reject(value);
        }
      };

      const abort = () => settle(false, abortError());
      timeout = setTimeout(() => {
        settle(false, new Error(withStderr('Timed out while improving prompt', stderrLines)));
      }, PROMPT_IMPROVE_TIMEOUT_MS);
      signal?.addEventListener('abort', abort, { once: true });

      child.on('error', error => settle(false, error));
      child.on('close', (code, closeSignal) => {
        if (!settled) {
          const message = closeSignal
            ? `microClaude prompt improvement exited with signal ${closeSignal}`
            : `microClaude prompt improvement exited with code ${code}`;
          settle(false, new Error(withStderr(message, stderrLines)));
        }
      });

      createInterface({ input: child.stderr }).on('line', line => {
        pushRing(stderrLines, line, MAX_STDERR_LINES);
      });

      createInterface({ input: child.stdout }).on('line', line => {
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          return;
        }

        if (parsed.type === 'control_request') {
          writeJson(child.stdin, {
            type: 'control_response',
            response: {
              subtype: 'success',
              request_id: parsed.request_id,
              response: { behavior: 'deny', message: 'Prompt improvement does not allow tool calls.' },
            },
          });
          return;
        }

        const mapped = mapper.map(parsed);
        for (const mappedEvent of mapped.events) {
          if (mappedEvent.name === 'assistant.delta' && typeof mappedEvent.payload?.text === 'string') {
            deltaText += mappedEvent.payload.text;
          }
          if (mappedEvent.name === 'assistant.message' && typeof mappedEvent.payload?.text === 'string') {
            assistantText = mappedEvent.payload.text;
          }
        }

        if (mapped.done) {
          if (mapped.error) {
            settle(false, mapped.error);
          } else {
            settle(true, { prompt: (assistantText || deltaText).trim(), fallback: false });
          }
        }
      });

      writeJson(child.stdin, createUserMessage(sessionId, instruction || 'Improve this prompt.'));
    });
  }

  async sendMessage({ session, prompt, content, emit, signal }) {
    const handle = this.#getOrStart(session, emit);
    if (handle.activeTurn) {
      throw new Error(`microClaude session is busy: ${session.id}`);
    }

    const turn = createTurn();
    handle.activeTurn = turn;

    const abort = () => {
      handle.cancelTurn(turn);
    };

    signal?.addEventListener('abort', abort, { once: true });

    try {
      writeJson(handle.child.stdin, createUserMessage(session.id, prompt, content));
      await turn.done;
    } finally {
      signal?.removeEventListener('abort', abort);
      if (handle.activeTurn === turn) {
        handle.activeTurn = null;
      }
    }
  }

  resolvePermission(params) {
    const requestId = params.requestId;
    if (!requestId || typeof requestId !== 'string') {
      throw new Error('requestId must be a non-empty string');
    }

    const pending = this.#pendingPermissions.get(requestId);
    if (!pending) {
      return { resolved: false, requestId };
    }

    const approve = params.approve;
    // The control protocol requires an allow response to echo back the (possibly edited) tool
    // input. When the caller does not override it, fall back to the original requested input —
    // omitting it makes the CLI treat the allow as malformed and run the tool as denied.
    const allowInput = params.updatedInput ?? pending.request?.input ?? {};
    const innerResponse = approve
      ? {
          behavior: 'allow',
          updatedInput: allowInput,
          ...(params.updatedPermissions ? { updatedPermissions: params.updatedPermissions } : {}),
        }
      : {
          behavior: 'deny',
          message: params.reason || 'Rejected by MicroIDE',
        };

    const response = {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: innerResponse,
      },
    };

    writeJson(pending.handle.child.stdin, response);
    this.#pendingPermissions.delete(requestId);
    return { resolved: true, requestId };
  }

  cancelSession(sessionId) {
    const handle = this.#handles.get(sessionId);
    if (!handle) {
      return false;
    }

    if (handle.activeTurn) {
      handle.cancelTurn(handle.activeTurn);
    } else {
      handle.kill();
      this.#handles.delete(sessionId);
    }
    return true;
  }

  disposeSession(sessionId) {
    return this.cancelSession(sessionId);
  }

  resetSession(sessionId) {
    return this.cancelSession(sessionId);
  }

  shutdown() {
    for (const handle of this.#handles.values()) {
      handle.kill();
    }
    this.#handles.clear();
    this.#pendingPermissions.clear();
    for (const [requestId, pending] of this.#pendingControlRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`microClaude control request was cancelled: ${pending.subtype}`));
      this.#pendingControlRequests.delete(requestId);
    }
  }

  #getOrStart(session, emit) {
    const existing = this.#handles.get(session.id);
    if (existing && !existing.closed && !existing.child.killed && !existing.child.stdin.destroyed) {
      return existing;
    }

    if (existing) {
      existing.clearCancelTimer?.();
      existing.kill();
      this.#handles.delete(session.id);
    }

    const handle = this.#spawn(session, emit);
    this.#handles.set(session.id, handle);
    return handle;
  }

  #spawn(session, emit) {
    if (!this.cliPath) {
      throw new Error('microClaude CLI path is required for microclaude engine mode');
    }
    if (!existsSync(this.cliPath)) {
      throw new Error(`microClaude CLI was not found: ${this.cliPath}`);
    }
    if (!this.runtimePath || !existsSync(this.runtimePath)) {
      throw new Error(`microClaude runtime was not found: ${this.runtimePath || '<empty>'}`);
    }

    const mapper = new MicroClaudeMessageMapper();
    const profile = createSessionProfile(session.mode);
    const args = [
      this.cliPath,
      '--print',
      ...profile.args,
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--replay-user-messages',
      '--permission-prompt-tool',
      'stdio',
      ...(session.resume ? ['--resume', session.id] : ['--session-id', session.id]),
      ...permissionArgs(session.permissionMode),
      ...filterExtraArgs(this.extraArgs, profile),
    ];

    // Once this task id has been used to launch a CLI process, future launches
    // must resume the persisted transcript instead of trying to create the same
    // session id again. This keeps follow-up messages working after cancellation.
    session.resume = true;

    const child = spawn(this.runtimePath, args, {
      cwd: session.workspace || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: createEngineEnv(
        this.env,
        this.envForModel(session.model),
        endpointEnv(session.endpoint),
        profile.env,
        {
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          FORCE_COLOR: '0',
          NO_COLOR: '1',
        },
      ),
      windowsHide: true,
    });

    const handle = {
      child,
      mapper,
      activeTurn: null,
      cancelTimer: undefined,
      closed: false,
      stderrLines: [],
      kill: () => {
        if (!child.killed) {
          child.kill();
        }
      },
      clearCancelTimer: () => {
        if (handle.cancelTimer) {
          clearTimeout(handle.cancelTimer);
          handle.cancelTimer = undefined;
        }
      },
      cancelTurn: turn => {
        if (!turn || turn.cancelRequested) {
          return;
        }
        turn.cancelRequested = true;

        let requestedInteractiveCancel = false;
        try {
          // The interactive CLI listens for Escape on a TTY. In stream-json mode stdin is
          // an NDJSON pipe, so a raw Escape byte would corrupt the next JSON message.
          if (child.stdin?.isTTY && !child.killed && child.stdin?.writable && !child.stdin.destroyed) {
            child.stdin.write(ESCAPE_KEY);
            requestedInteractiveCancel = true;
          }
        } catch {
          requestedInteractiveCancel = false;
        }

        const hardStop = () => {
          if (handle.activeTurn !== turn) {
            return;
          }
          handle.kill();
          handle.clearCancelTimer();
          handle.cancelTimer = setTimeout(() => {
            if (handle.activeTurn === turn) {
              turn.reject(abortError());
              handle.activeTurn = null;
            }
          }, TURN_CANCEL_KILL_GRACE_MS);
        };

        handle.clearCancelTimer();
        if (requestedInteractiveCancel) {
          handle.cancelTimer = setTimeout(hardStop, TURN_CANCEL_GRACE_MS);
        } else {
          hardStop();
        }
      },
    };

    child.on('close', (code, signal) => {
      handle.closed = true;
      this.#handles.delete(session.id);
      this.#dropPermissionsForHandle(handle);
      this.#dropControlRequestsForHandle(handle, signal
        ? `microClaude process exited with signal ${signal}`
        : `microClaude process exited with code ${code}`);

      handle.clearCancelTimer();
      if (handle.activeTurn) {
        const message = signal
          ? `microClaude process exited with signal ${signal}`
          : `microClaude process exited with code ${code}`;
        const error = handle.activeTurn.cancelRequested
          ? abortError()
          : new Error(withStderr(message, handle.stderrLines));
        handle.activeTurn.reject(error);
        handle.activeTurn = null;
      }
    });

    child.on('error', err => {
      handle.closed = true;
      this.#handles.delete(session.id);
      this.#dropPermissionsForHandle(handle);
      this.#dropControlRequestsForHandle(handle, err?.message || 'microClaude process error');
      handle.clearCancelTimer();
      handle.activeTurn?.reject(err);
      handle.activeTurn = null;
    });

    createInterface({ input: child.stdout }).on('line', line => {
      this.#handleStdoutLine({ line, handle, session, emit });
    });

    createInterface({ input: child.stderr }).on('line', line => {
      pushRing(handle.stderrLines, line, MAX_STDERR_LINES);
      emit('engine.stderr', { line });
    });

    emit('engine.started', {
      pid: child.pid,
      runtimePath: this.runtimePath,
      cliPath: this.cliPath,
      mode: session.mode || 'agent',
      profile: profile.name,
    });

    return handle;
  }

  #handleStdoutLine({ line, handle, session, emit }) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      emit('engine.stdout', { line });
      return;
    }

    if (parsed.type === 'control_request') {
      this.#trackPermission(handle, parsed);
    }
    if (parsed.type === 'control_response' && this.#resolveControlRequest(handle, parsed)) {
      return;
    }

    const mapped = handle.mapper.map(parsed);
    for (const mappedEvent of mapped.events) {
      emit(mappedEvent.name, mappedEvent.payload);
    }

    if (mapped.done && handle.activeTurn) {
      handle.clearCancelTimer();
      if (handle.activeTurn.cancelRequested) {
        handle.activeTurn.reject(abortError());
      } else if (mapped.error) {
        handle.activeTurn.reject(mapped.error);
      } else {
        handle.activeTurn.resolve();
      }
      handle.activeTurn = null;
    }
  }

  #trackPermission(handle, message) {
    const requestId = message.request_id;
    if (!requestId) {
      return;
    }

    this.#pendingPermissions.set(requestId, {
      handle,
      toolUseId: message.request?.tool_use_id,
      request: message.request,
    });
  }

  #dropPermissionsForHandle(handle) {
    for (const [requestId, pending] of this.#pendingPermissions) {
      if (pending.handle === handle) {
        this.#pendingPermissions.delete(requestId);
      }
    }
  }

  #resolveControlRequest(handle, message) {
    const response = message.response;
    const requestId = response?.request_id;
    if (!requestId) {
      return false;
    }
    const pending = this.#pendingControlRequests.get(requestId);
    if (!pending || pending.handle !== handle) {
      return false;
    }

    clearTimeout(pending.timeout);
    this.#pendingControlRequests.delete(requestId);
    if (response.subtype === 'success') {
      pending.resolve(response.response ?? {});
    } else {
      pending.reject(new Error(response.error || `microClaude control request failed: ${pending.subtype}`));
    }
    return true;
  }

  #dropControlRequestsForHandle(handle, reason) {
    for (const [requestId, pending] of this.#pendingControlRequests) {
      if (pending.handle === handle) {
        clearTimeout(pending.timeout);
        pending.reject(new Error(`${reason}: ${pending.subtype}`));
        this.#pendingControlRequests.delete(requestId);
      }
    }
  }
}

export function createSessionProfile(mode = 'agent') {
  if (mode === 'multiAgent') {
    return {
      name: 'agent-teams',
      args: ['--teammate-mode', 'in-process'],
      env: {
        CLAUDE_CODE_SIMPLE: undefined,
        ...AGENT_TEAM_ENV,
      },
    };
  }

  return {
    name: 'simple',
    args: ['--bare'],
    env: {
      CLAUDE_CODE_SIMPLE: '1',
    },
  };
}

export function filterExtraArgs(extraArgs, profile) {
  if (profile.name !== 'agent-teams') {
    return extraArgs;
  }

  const filtered = [];
  for (let index = 0; index < extraArgs.length; index += 1) {
    const arg = extraArgs[index];
    if (arg === '--bare' || arg.startsWith('--bare=')) {
      continue;
    }
    if (arg === '--teammate-mode') {
      index += 1;
      continue;
    }
    if (arg.startsWith('--teammate-mode=')) {
      continue;
    }
    filtered.push(arg);
  }
  return filtered;
}

export function createEngineEnv(...sources) {
  const env = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source ?? {})) {
      if (value === undefined || value === null) {
        delete env[key];
      } else {
        env[key] = String(value);
      }
    }
  }
  return env;
}

function normalizeSlashCommands(commands) {
  if (!Array.isArray(commands)) {
    return [];
  }

  const seen = new Set();
  const normalized = [];
  for (const command of commands) {
    if (!command || typeof command !== 'object') {
      continue;
    }
    const name = String(command.name || '').replace(/^\//, '').trim();
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    normalized.push({
      name,
      description: typeof command.description === 'string' ? command.description : '',
      argumentHint: typeof command.argumentHint === 'string' ? command.argumentHint : '',
    });
  }
  return normalized;
}

function normalizeModelOptions(models) {
  if (!Array.isArray(models)) {
    return [];
  }

  const seen = new Set();
  const normalized = [];
  for (const model of models) {
    if (!model || typeof model !== 'object') {
      continue;
    }

    const id = normalizeNonEmptyString(model.value ?? model.id ?? model.model);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);

    const supportedEffortLevels = Array.isArray(model.supportedEffortLevels)
      ? model.supportedEffortLevels
        .map(normalizeEffortValue)
        .filter(level => level && level !== 'auto')
      : [];

    normalized.push({
      id,
      label: normalizeNonEmptyString(model.displayName ?? model.label ?? model.name) ?? id,
      ...(normalizeNonEmptyString(model.provider) ? { provider: normalizeNonEmptyString(model.provider) } : {}),
      ...(normalizeNonEmptyString(model.baseUrl) ? { baseUrl: normalizeNonEmptyString(model.baseUrl) } : {}),
      ...(normalizeNonEmptyString(model.description) ? { description: normalizeNonEmptyString(model.description) } : {}),
      ...(positiveInteger(model.contextWindow ?? model.contextWindowTokens ?? model.maxContextTokens) ? { contextWindow: positiveInteger(model.contextWindow ?? model.contextWindowTokens ?? model.maxContextTokens) } : {}),
      ...(finiteNumber(model.weight) !== undefined ? { weight: finiteNumber(model.weight) } : {}),
      ...(normalizeNonEmptyString(model.tier) ? { tier: normalizeNonEmptyString(model.tier) } : {}),
      ...(model.custom === true ? { custom: true } : {}),
      ...(model.supportsEffort === true ? { supportsEffort: true } : {}),
      ...(supportedEffortLevels.length ? { supportedEffortLevels: [...new Set(supportedEffortLevels)] } : {}),
      ...(model.supportsAdaptiveThinking === true ? { supportsAdaptiveThinking: true } : {}),
      ...(model.supportsFastMode === true ? { supportsFastMode: true } : {}),
      ...(model.supportsAutoMode === true ? { supportsAutoMode: true } : {}),
    });
  }

  return normalized;
}

function normalizeFastModeState(state) {
  return state === 'on' || state === 'off' || state === 'cooldown' ? state : undefined;
}

function normalizePlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function normalizeEffortValue(value) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const normalized = String(value).trim().toLowerCase().replace(/^extra-high$/, 'xhigh');
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

  return undefined;
}

function normalizeRuntimeSettings(response) {
  const effective = normalizePlainObject(response?.effective) ?? {};
  const sources = Array.isArray(response?.sources)
    ? response.sources
      .filter(source => source && typeof source === 'object')
      .map(source => ({
        source: normalizeNonEmptyString(source.source) ?? 'unknown',
        settings: normalizePlainObject(source.settings) ?? {},
      }))
    : [];

  return {
    effective,
    sources,
    applied: normalizeAppliedSettings(response?.applied),
  };
}

function normalizeAppliedSettings(applied) {
  const source = normalizePlainObject(applied);
  if (!source) {
    return undefined;
  }

  const effort = normalizeEffortValue(source.effort);
  return {
    ...(normalizeNonEmptyString(source.model) ? { model: normalizeNonEmptyString(source.model) } : {}),
    ...(source.effort === null ? { effort: null } : effort ? { effort } : {}),
  };
}

function normalizeThinkingState(maxThinkingTokens) {
  if (maxThinkingTokens === 0) {
    return { enabled: false, mode: 'disabled', maxThinkingTokens: 0 };
  }

  if (typeof maxThinkingTokens === 'number' && Number.isFinite(maxThinkingTokens) && maxThinkingTokens > 0) {
    return { enabled: true, mode: 'budget', maxThinkingTokens: Math.round(maxThinkingTokens) };
  }

  return { enabled: true, mode: 'auto', maxThinkingTokens: null };
}

function normalizeNonEmptyString(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function positiveInteger(value) {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(number) && number > 0 ? Math.round(number) : undefined;
}

function finiteNumber(value) {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(number) ? number : undefined;
}

function createTurn() {
  let resolveTurn;
  let rejectTurn;
  const done = new Promise((resolve, reject) => {
    resolveTurn = resolve;
    rejectTurn = reject;
  });

  return {
    done,
    resolve: resolveTurn,
    reject: rejectTurn,
    cancelRequested: false,
  };
}

function createUserMessage(sessionId, content, contentBlocks) {
  return {
    type: 'user',
    uuid: randomUUID(),
    session_id: sessionId,
    message: {
      role: 'user',
      content: Array.isArray(contentBlocks) && contentBlocks.length ? contentBlocks : (content || ''),
    },
    parent_tool_use_id: null,
  };
}

function writeJson(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

function pushRing(items, item, limit) {
  if (items.length >= limit) {
    items.shift();
  }
  items.push(item);
}

function permissionArgs(mode) {
  if (mode === 'acceptEdits') {
    return ['--permission-mode', 'acceptEdits'];
  }
  if (mode === 'bypassPermissions') {
    return ['--dangerously-skip-permissions'];
  }
  return [];
}

// Translate a per-session custom endpoint into engine environment overrides. Only the keys
// actually provided are set, so a custom model that only overrides the base URL still inherits
// the ambient token.
function endpointEnv(endpoint) {
  if (!endpoint) {
    return {};
  }
  const env = {};
  if (endpoint.baseUrl) {
    env.ANTHROPIC_BASE_URL = endpoint.baseUrl;
  }
  if (endpoint.apiKey) {
    env.ANTHROPIC_AUTH_TOKEN = endpoint.apiKey;
    env.ANTHROPIC_API_KEY = endpoint.apiKey;
  }
  return env;
}

function withStderr(message, lines) {
  if (!lines.length) {
    return message;
  }

  return `${message}\n${lines.join('\n')}`;
}

function abortError() {
  const error = new Error('Request cancelled');
  error.name = 'AbortError';
  return error;
}
