import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createEngineEnv,
  createSessionProfile,
  filterExtraArgs,
} from '../adapter/microClaudeCliEngine.js';

test('multiAgent profile enables agent teams without bare SIMPLE mode', () => {
  const profile = createSessionProfile('multiAgent');
  const env = createEngineEnv(
    { CLAUDE_CODE_SIMPLE: '1', KEEP_ME: 'yes' },
    { ANTHROPIC_MODEL: 'MiniMax-M3', CLAUDE_CODE_SIMPLE: '1' },
    profile.env,
  );
  const args = filterExtraArgs(
    ['--bare', '--teammate-mode', 'tmux', '--debug'],
    profile,
  );

  assert.equal(profile.name, 'agent-teams');
  assert.deepEqual(profile.args, ['--teammate-mode', 'in-process']);
  assert.equal(env.CLAUDE_CODE_SIMPLE, undefined);
  assert.equal(env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, '1');
  assert.equal(env.CLAUDE_CODE_ENABLE_TASKS, '1');
  assert.equal(env.KEEP_ME, 'yes');
  assert.deepEqual(args, ['--debug']);
});

test('agent profile keeps the existing bare SIMPLE mode', () => {
  const profile = createSessionProfile('agent');
  const env = createEngineEnv({}, profile.env);
  const args = filterExtraArgs(['--bare', '--debug'], profile);

  assert.equal(profile.name, 'simple');
  assert.deepEqual(profile.args, ['--bare']);
  assert.equal(env.CLAUDE_CODE_SIMPLE, '1');
  assert.deepEqual(args, ['--bare', '--debug']);
});
