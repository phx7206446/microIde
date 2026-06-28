export const PROTOCOL_VERSION = '1.0.0';

export const CAPABILITIES = Object.freeze({
  chat: true,
  agent: true,
  applyPatch: true,
  terminal: true,
  mcp: true,
  repoWiki: false,
  memory: false,
  streamingEvents: true,
  cancellation: true,
  permissionResolution: true,
  agentTeams: true,
  skills: true,
  plugins: true,
  browserView: true,
});

export const ErrorCode = Object.freeze({
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  SessionNotFound: -32001,
  SessionBusy: -32002,
});

export function ok(id, result) {
  return { jsonrpc: '2.0', id, result };
}

export function error(id, code, message, data) {
  const response = {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message },
  };

  if (data !== undefined) {
    response.error.data = data;
  }

  return response;
}

export function event(sessionId, name, payload = {}) {
  return {
    type: 'event',
    sessionId: sessionId ?? null,
    event: name,
    payload,
  };
}

export function isRequest(value) {
  return Boolean(
    value &&
      typeof value === 'object' &&
      value.jsonrpc === '2.0' &&
      Object.hasOwn(value, 'id') &&
      typeof value.method === 'string',
  );
}

export function requireObject(value, fallback = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fallback;
  }

  return value;
}

export function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ProtocolError(ErrorCode.InvalidParams, `${name} must be a non-empty string`);
  }

  return value;
}

export class ProtocolError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
    this.data = data;
  }
}
