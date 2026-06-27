import { setTimeout as delay } from 'node:timers/promises';

const STREAM_DELAY_MS = 18;

export class LightweightEngine {
  async listCommands() {
    return { commands: [] };
  }

  async listModels() {
    return { models: [] };
  }

  async setModel({ model }) {
    return {
      requestedModel: model || 'default',
      model: model || 'default',
      settings: {
        effective: {},
        sources: [],
        applied: { model: model || 'default', effort: null },
      },
    };
  }

  async setThinking({ maxThinkingTokens }) {
    return { thinking: normalizeThinkingState(maxThinkingTokens) };
  }

  async setEffort({ effort }) {
    const normalized = normalizeEffortValue(effort) ?? 'high';
    return {
      effort: normalized,
      applied: { model: 'default', effort: normalized },
    };
  }

  async getSettings() {
    return {
      effective: {},
      sources: [],
      applied: { model: 'default', effort: null },
    };
  }

  async improvePrompt({ prompt, mode }) {
    return { prompt: fallbackImprovePrompt(prompt, mode), fallback: true };
  }

  resetSession() {
    return false;
  }

  async sendMessage({ session, prompt, emit, signal }) {
    const startedAt = Date.now();

    emit('todo.update', {
      items: [
        { id: 'receive-message', text: 'Receive MicroIDE request', status: 'completed' },
        { id: 'compose-response', text: 'Compose sidecar response', status: 'in_progress' },
      ],
    });

    const response = [
      'microClaude sidecar is online.',
      `Session ${session.id} received your request.`,
      prompt ? `Prompt: ${prompt}` : 'No prompt content was provided.',
      'The protocol stream is ready for the real microClaude engine bridge.',
    ].join(' ');

    let fullText = '';
    for (const token of tokenize(response)) {
      throwIfAborted(signal);
      fullText += token;
      emit('assistant.delta', { text: token });
      await delay(STREAM_DELAY_MS, undefined, { signal });
    }

    emit('todo.update', {
      items: [
        { id: 'receive-message', text: 'Receive MicroIDE request', status: 'completed' },
        { id: 'compose-response', text: 'Compose sidecar response', status: 'completed' },
      ],
    });

    emit('assistant.message', {
      text: fullText,
      elapsedMs: Date.now() - startedAt,
      engine: 'lightweight',
    });
  }
}

function fallbackImprovePrompt(prompt, mode) {
  const normalizedMode = mode === 'working' ? 'working' : 'coding';
  const base = typeof prompt === 'string' && prompt.trim()
    ? prompt.trim()
    : normalizedMode === 'working'
      ? 'Help me complete this workplace task.'
      : 'Help me complete this coding task.';
  if (/Please work in this structure:/i.test(base)) {
    return base;
  }
  const steps = normalizedMode === 'working'
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

function tokenize(text) {
  const parts = text.match(/\S+\s*/g);
  return parts ?? [];
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const error = new Error('Request cancelled');
    error.name = 'AbortError';
    throw error;
  }
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

function normalizeEffortValue(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase().replace(/^extra-high$/, 'xhigh');
  return normalized === 'low' ||
    normalized === 'medium' ||
    normalized === 'high' ||
    normalized === 'xhigh' ||
    normalized === 'max' ||
    normalized === 'ultracode'
    ? normalized
    : undefined;
}
