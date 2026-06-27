import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sidecarPath = resolve(__dirname, '..', 'adapter', 'index.js');
const repoRoot = resolve(__dirname, '..', '..', '..');
const defaultConfigPath = resolve(repoRoot, '.runtime', 'microide', 'microclaude.config.json');

const child = spawn(process.execPath, [
  sidecarPath,
  '--workspace',
  process.cwd(),
  '--default-config',
  defaultConfigPath,
], {
  cwd: repoRoot,
  stdio: ['pipe', 'pipe', 'pipe'],
});

const messages = [];
let buffer = '';

child.stdout.setEncoding('utf8');
child.stdout.on('data', chunk => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf('\n');
    if (index === -1) {
      break;
    }

    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) {
      messages.push(JSON.parse(line));
    }
  }
});

let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', chunk => {
  stderr += chunk;
});

try {
  const ping = await request('1', 'sidecar.ping', {});
  assert.equal(ping.result.status, 'ok');
  assert.equal(ping.result.protocolVersion, '1.0.0');
  assert.equal(ping.result.configuration.selectedModel, 'MiniMax-M3');
  assert.equal(ping.result.configuration.defaultModel, 'MiniMax-M3');
  assert.equal(ping.result.configuration.models[0].id, 'MiniMax-M3');
  assert.equal(ping.result.configuration.models[0].provider, 'MiniMax');
  assert.equal(ping.result.configuration.models[0].baseUrl, 'https://api.minimaxi.com/anthropic');

  const capabilities = await request('2', 'sidecar.getCapabilities', {});
  assert.equal(capabilities.result.capabilities.streamingEvents, true);
  assert.equal(capabilities.result.configuration.selectedModel, 'MiniMax-M3');

  const commands = await request('2b', 'commands.list', { workspace: repoRoot });
  assert.equal(commands.result.engine, 'lightweight');
  assert.ok(Array.isArray(commands.result.commands));
  assert.equal(typeof commands.result.refreshedAt, 'string');

  const models = await request('2c', 'models.list', { workspace: repoRoot });
  assert.equal(models.result.engine, 'lightweight');
  assert.ok(Array.isArray(models.result.models));
  assert.equal(typeof models.result.refreshedAt, 'string');

  const improvedPrompt = await request('2d', 'prompt.improve', {
    workspace: repoRoot,
    mode: 'coding',
    prompt: 'fix this bug',
    context: [{ path: 'src/example.ts', source: 'mention' }],
  });
  assert.equal(improvedPrompt.result.engine, 'lightweight');
  assert.equal(improvedPrompt.result.fallback, true);
  assert.match(improvedPrompt.result.prompt, /fix this bug/);
  assert.equal(typeof improvedPrompt.result.refreshedAt, 'string');

  const started = await request('3', 'session.start', { mode: 'agent' });
  const sessionId = started.result.session.id;
  assert.ok(sessionId);

  const modelSet = await request('3a', 'model.set', { sessionId, model: 'MiniMax-M3' });
  assert.equal(modelSet.result.sessionId, sessionId);
  assert.equal(modelSet.result.model, 'MiniMax-M3');

  const thinkingSet = await request('3b', 'thinking.set', { sessionId, enabled: false });
  assert.equal(thinkingSet.result.sessionId, sessionId);
  assert.equal(thinkingSet.result.thinking.enabled, false);
  assert.equal(thinkingSet.result.thinking.maxThinkingTokens, 0);

  const effortSet = await request('3c', 'effort.set', { sessionId, effort: 'ultracode' });
  assert.equal(effortSet.result.sessionId, sessionId);
  assert.equal(effortSet.result.effort, 'ultracode');

  const modelSettings = await request('3d', 'modelSettings.get', { sessionId });
  assert.equal(modelSettings.result.sessionId, sessionId);
  assert.equal(modelSettings.result.applied.model, 'default');

  const accepted = await request('4', 'message.send', {
    sessionId,
    prompt: 'Build a clean sidecar bridge.',
  });
  assert.equal(accepted.result.accepted, true);

  const assistantMessage = await waitFor(
    message => message.type === 'event' && message.event === 'assistant.message',
    3000,
  );
  assert.match(assistantMessage.payload.text, /microClaude sidecar is online/);

  // Rich input: a message carrying structured content blocks (text + image)
  // must be accepted without disturbing the JSON-RPC protocol.
  const richAccepted = await request('4b', 'message.send', {
    sessionId,
    content: [
      { type: 'text', text: 'Describe this screenshot.' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
    ],
  });
  assert.equal(richAccepted.result.accepted, true);
  await waitFor(
    message => message.type === 'event' && message.event === 'assistant.message',
    3000,
  );

  // Resume: resuming an unknown session id should recreate the record and
  // report resumed=true (CLI engine would then start with --resume).
  const resumed = await request('4c', 'session.resume', { sessionId: 'resume-smoke-session', mode: 'agent' });
  assert.equal(resumed.result.resumed, true);
  assert.equal(resumed.result.session.id, 'resume-smoke-session');

  const cancel = await request('5', 'session.cancel', { sessionId });
  assert.equal(cancel.result.cancelled, false);

  const disposed = await request('6', 'session.dispose', { sessionId });
  assert.equal(disposed.result.disposed, true);
} finally {
  child.kill();
}

console.log('microclaude sidecar smoke ok');

function request(id, method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return waitFor(message => message.jsonrpc === '2.0' && message.id === id, 2000);
}

function waitFor(predicate, timeoutMs) {
  const startedAt = Date.now();

  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setInterval(() => {
      const index = messages.findIndex(predicate);
      if (index !== -1) {
        clearInterval(timer);
        const [message] = messages.splice(index, 1);
        resolvePromise(message);
        return;
      }

      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        rejectPromise(new Error(`Timed out waiting for sidecar message. stderr=${stderr}`));
      }
    }, 10);
  });
}
