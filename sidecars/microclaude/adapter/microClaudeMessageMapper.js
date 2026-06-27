export class MicroClaudeMessageMapper {
  #text = '';
  #assistantMessageEmitted = false;
  #toolRequests = new Map();

  map(message) {
    if (!message || typeof message !== 'object') {
      return { events: [], done: false };
    }

    switch (message.type) {
      case 'system':
        return this.#mapSystem(message);

      case 'stream_event':
        return this.#mapStreamEvent(message);

      case 'assistant':
        return this.#mapAssistant(message);

      case 'user':
        return this.#mapUser(message);

      case 'control_request':
        return {
          events: [
            {
              name: 'permission.request',
              payload: {
                requestId: message.request_id,
                request: message.request,
                raw: message,
              },
            },
          ],
          done: false,
        };

      case 'control_cancel_request':
        return {
          events: [
            {
              name: 'permission.cancel',
              payload: {
                requestId: message.request_id,
                raw: message,
              },
            },
          ],
          done: false,
        };

      case 'result':
        return this.#mapResult(message);

      default:
        return { events: [], done: false };
    }
  }

  #mapStreamEvent(message) {
    const rawEvent = message.event;
    const events = [];

    if (rawEvent?.type === 'content_block_delta' && rawEvent.delta?.type === 'text_delta') {
      const text = rawEvent.delta.text || '';
      if (text) {
        this.#text += text;
        events.push({ name: 'assistant.delta', payload: { text, raw: message } });
      }
    }

    if (rawEvent?.type === 'content_block_start' && rawEvent.content_block?.type === 'tool_use') {
      const block = rawEvent.content_block;
      events.push(this.#createToolRequestEvent(block, message));
    }

    return { events, done: false };
  }

  #mapAssistant(message) {
    const events = [];
    const content = message.message?.content;

    if (Array.isArray(content)) {
      let assistantText = '';

      for (const block of content) {
        if (!block || typeof block !== 'object') {
          continue;
        }

        if (block.type === 'text' && typeof block.text === 'string') {
          assistantText += block.text;
        }

        if (block.type === 'tool_use') {
          events.push(this.#createToolRequestEvent(block, message));
        }
      }

      if (assistantText) {
        if (!this.#text) {
          this.#text = assistantText;
        }

        this.#assistantMessageEmitted = true;
        events.push({
          name: 'assistant.message',
          payload: {
            text: assistantText,
            raw: message,
            engine: 'microclaude',
          },
        });
        events.push(...mapTeammateMessages(assistantText, message));
      }
    }

    return { events, done: false };
  }

  #mapUser(message) {
    const events = [];
    const content = message.message?.content ?? message.content;

    if (!Array.isArray(content)) {
      if (typeof content === 'string') {
        events.push(...mapTeammateMessages(content, message));
      }
      return { events, done: false };
    }

    const userText = content
      .map(block => {
        if (typeof block === 'string') {
          return block;
        }
        if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
          return block.text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
    if (userText) {
      events.push(...mapTeammateMessages(userText, message));
    }

    const toolResults = content.filter(block => block && typeof block === 'object' && block.type === 'tool_result');
    for (const block of toolResults) {
      const toolUseId = block.tool_use_id ?? block.toolUseId;
      const request = typeof toolUseId === 'string' ? this.#toolRequests.get(toolUseId) : undefined;
      const output = toolResults.length === 1
        ? (message.toolUseResult ?? message.tool_use_result ?? block.content)
        : block.content;

      const payload = {
        toolUseId,
        name: request?.name,
        input: request?.input,
        content: block.content,
        output,
        isError: Boolean(block.is_error ?? block.isError ?? message.is_error),
        raw: message,
      };

      events.push({
        name: 'tool.result',
        payload,
      });
      events.push(...mapTeamToolResult(payload));

      if (typeof toolUseId === 'string') {
        this.#toolRequests.delete(toolUseId);
      }
    }

    return { events, done: false };
  }

  #createToolRequestEvent(block, raw) {
    const toolUseId = block.id ?? block.tool_use_id ?? block.toolUseId;
    const payload = {
      toolUseId,
      name: block.name,
      input: block.input ?? {},
      raw,
    };

    if (typeof toolUseId === 'string') {
      this.#toolRequests.set(toolUseId, {
        name: block.name,
        input: block.input ?? {},
      });
    }

    return {
      name: 'tool.request',
      payload,
    };
  }

  #mapSystem(message) {
    const events = [];
    switch (message.subtype) {
      case 'task_started':
        events.push({
          name: 'task.started',
          payload: normalizeTaskEvent(message),
        });
        break;
      case 'task_progress':
        events.push({
          name: 'task.progress',
          payload: normalizeTaskEvent(message),
        });
        break;
      case 'task_updated':
        events.push({
          name: 'task.updated',
          payload: normalizeTaskEvent(message),
        });
        break;
      case 'task_notification':
        events.push({
          name: 'task.notification',
          payload: normalizeTaskEvent(message),
        });
        break;
      case 'session_state_changed':
        events.push({
          name: 'session.status',
          payload: {
            status: message.state === 'running' ? 'busy' : message.state === 'idle' ? 'ready' : 'requires_action',
            microClaudeSessionId: message.session_id,
            raw: message,
          },
        });
        break;
      default:
        events.push({
          name: 'session.status',
          payload: {
            status: 'initialized',
            microClaudeSessionId: message.session_id,
            raw: message,
          },
        });
        break;
    }

    return { events, done: false };
  }

  #mapResult(message) {
    const events = [];
    const success = message.subtype === 'success' && !message.is_error;

    if (!this.#assistantMessageEmitted && (this.#text || typeof message.result === 'string')) {
      events.push({
        name: 'assistant.message',
        payload: {
          text: this.#text || message.result,
          raw: message,
          engine: 'microclaude',
        },
      });
      this.#assistantMessageEmitted = true;
    }

    events.push({
      name: 'session.result',
      payload: {
        success,
        subtype: message.subtype,
        durationMs: message.duration_ms,
        raw: message,
      },
    });

    if (!success) {
      events.push({
        name: 'session.error',
        payload: {
          message: message.error || message.subtype || 'microClaude turn failed',
          raw: message,
        },
      });
    }

    const result = {
      events,
      done: true,
      error: success ? null : new Error(message.error || message.subtype || 'microClaude turn failed'),
    };
    this.#resetTurn();
    return result;
  }

  #resetTurn() {
    this.#text = '';
    this.#assistantMessageEmitted = false;
    this.#toolRequests.clear();
  }
}

function mapTeamToolResult(payload) {
  const toolName = payload.name;
  if (typeof toolName !== 'string') {
    return [];
  }

  const output = extractStructuredOutput(payload.output ?? payload.content);
  const input = asRecord(payload.input);
  const events = [];

  if (toolName === 'TeamCreate') {
    const data = asRecord(output);
    if (data?.team_name || data?.teamName) {
      events.push({
        name: 'team.created',
        payload: {
          teamName: data.team_name ?? data.teamName,
          teamFilePath: data.team_file_path ?? data.teamFilePath,
          leadAgentId: data.lead_agent_id ?? data.leadAgentId,
          toolUseId: payload.toolUseId,
          input,
          raw: payload.raw,
        },
      });
    }
  } else if (toolName === 'Agent') {
    const data = asRecord(output);
    if (data?.status === 'teammate_spawned') {
      events.push({
        name: 'team.teammate.started',
        payload: {
          teammateId: data.teammate_id ?? data.teammateId ?? data.agent_id ?? data.agentId,
          agentId: data.agent_id ?? data.agentId ?? data.teammate_id ?? data.teammateId,
          name: data.name,
          agentType: data.agent_type ?? data.agentType ?? input?.subagent_type,
          model: data.model,
          color: data.color,
          teamName: data.team_name ?? data.teamName ?? input?.team_name,
          backend: data.tmux_session_name === 'in-process' ? 'in-process' : data.tmux_session_name ? 'pane' : undefined,
          planModeRequired: Boolean(data.plan_mode_required ?? data.planModeRequired),
          toolUseId: payload.toolUseId,
          input,
          raw: payload.raw,
        },
      });
    }
  } else if (toolName === 'SendMessage') {
    const data = asRecord(output);
    events.push({
      name: 'team.message.sent',
      payload: {
        to: input?.to,
        summary: input?.summary,
        message: input?.message,
        success: Boolean(data?.success),
        routing: data?.routing,
        recipients: data?.recipients,
        requestId: data?.request_id ?? data?.requestId,
        target: data?.target,
        toolUseId: payload.toolUseId,
        raw: payload.raw,
      },
    });
  } else if (toolName === 'TeamDelete') {
    const data = asRecord(output);
    events.push({
      name: 'team.deleted',
      payload: {
        success: data?.success !== false,
        teamName: data?.team_name ?? data?.teamName,
        message: data?.message,
        toolUseId: payload.toolUseId,
        raw: payload.raw,
      },
    });
  } else if (toolName === 'TaskCreate' || toolName === 'TaskUpdate' || toolName === 'TaskList' || toolName === 'TaskGet') {
    events.push({
      name: 'team.task.updated',
      payload: {
        toolName,
        input,
        output,
        toolUseId: payload.toolUseId,
        raw: payload.raw,
      },
    });
  }

  return events;
}

function normalizeTaskEvent(message) {
  return {
    taskId: message.task_id ?? message.taskId,
    toolUseId: message.tool_use_id ?? message.toolUseId,
    description: message.description,
    taskType: message.task_type ?? message.taskType,
    status: message.status,
    summary: message.summary,
    outputFile: message.output_file ?? message.outputFile,
    prompt: message.prompt,
    usage: message.usage,
    patch: message.patch,
    workflowName: message.workflow_name ?? message.workflowName,
    workflowProgress: message.workflow_progress ?? message.workflowProgress,
    raw: message,
  };
}

function mapTeammateMessages(text, raw) {
  const events = [];
  const pattern = /<teammate_message\s+([^>]*)>\s*([\s\S]*?)\s*<\/teammate_message>/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const attrs = parseAttributes(match[1]);
    events.push({
      name: 'team.message.received',
      payload: {
        from: attrs.teammate_id ?? attrs.from,
        color: attrs.color,
        text: match[2],
        raw,
      },
    });
  }
  return events;
}

function parseAttributes(value) {
  const attrs = {};
  const pattern = /([A-Za-z0-9_-]+)="([^"]*)"/g;
  let match;
  while ((match = pattern.exec(value || '')) !== null) {
    attrs[match[1]] = match[2];
  }
  return attrs;
}

function extractStructuredOutput(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (value.data !== undefined) {
      return value.data;
    }
    return value;
  }

  if (Array.isArray(value)) {
    const text = value
      .map(item => {
        if (typeof item === 'string') {
          return item;
        }
        if (item && typeof item === 'object' && typeof item.text === 'string') {
          return item.text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
    return parseJsonObject(text) ?? text;
  }

  if (typeof value === 'string') {
    return parseJsonObject(value) ?? value;
  }

  return value;
}

function parseJsonObject(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
