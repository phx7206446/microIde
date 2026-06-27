import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MicroClaudeMessageMapper } from '../adapter/microClaudeMessageMapper.js';

test('mapper emits team lifecycle events from tool results', () => {
  const mapper = new MicroClaudeMessageMapper();

  mapper.map({
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', id: 'team-tool', name: 'TeamCreate', input: { team_name: 'microide-smoke' } },
        { type: 'tool_use', id: 'agent-tool', name: 'Agent', input: { name: 'tester', team_name: 'microide-smoke' } },
      ],
    },
  });

  const teamEvents = mapper.map({
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'team-tool',
          content: [{ type: 'text', text: '{"team_name":"microide-smoke","team_file_path":"teams/config.json","lead_agent_id":"team-lead@microide-smoke"}' }],
        },
      ],
    },
  }).events;

  assert.equal(teamEvents.some(event => event.name === 'team.created'), true);
  assert.equal(teamEvents.find(event => event.name === 'team.created').payload.teamName, 'microide-smoke');

  const teammateEvents = mapper.map({
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'agent-tool',
          content: [{ type: 'text', text: '{"status":"teammate_spawned","agent_id":"tester@microide-smoke","name":"tester","team_name":"microide-smoke","tmux_session_name":"in-process"}' }],
        },
      ],
    },
  }).events;

  assert.equal(teammateEvents.some(event => event.name === 'team.teammate.started'), true);
  assert.equal(teammateEvents.find(event => event.name === 'team.teammate.started').payload.backend, 'in-process');
});

test('mapper emits task events and teammate messages', () => {
  const mapper = new MicroClaudeMessageMapper();

  const taskEvents = mapper.map({
    type: 'system',
    subtype: 'task_started',
    task_id: 'in_process_teammate-1',
    tool_use_id: 'agent-tool',
    description: 'tester: run smoke',
    task_type: 'in_process_teammate',
  }).events;
  assert.equal(taskEvents[0].name, 'task.started');
  assert.equal(taskEvents[0].payload.taskId, 'in_process_teammate-1');

  const messageEvents = mapper.map({
    type: 'user',
    message: {
      content: [
        {
          type: 'text',
          text: '<teammate_message teammate_id="tester" color="blue">done with smoke</teammate_message>',
        },
      ],
    },
  }).events;
  assert.equal(messageEvents.some(event => event.name === 'team.message.received'), true);
  assert.equal(messageEvents.find(event => event.name === 'team.message.received').payload.from, 'tester');
});
