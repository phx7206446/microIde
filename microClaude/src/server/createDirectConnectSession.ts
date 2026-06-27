/* eslint-disable eslint-plugin-n/no-unsupported-features/node-builtins */

import { errorMessage } from '../utils/errors.js'
import { hashPair } from '../utils/hash.js'
import { jsonStringify } from '../utils/slowOperations.js'
import type { DirectConnectConfig } from './directConnectManager.js'
import { connectResponseSchema } from './types.js'

/**
 * Errors thrown by createDirectConnectSession when the connection fails.
 */
export class DirectConnectError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DirectConnectError'
  }
}

/**
 * Create a session on a direct-connect server.
 *
 * Posts to `${serverUrl}/sessions`, validates the response, and returns
 * a DirectConnectConfig ready for use by the REPL or headless runner.
 *
 * Throws DirectConnectError on network, HTTP, or response-parsing failures.
 */
export async function createDirectConnectSession({
  serverUrl,
  authToken,
  cwd,
  dangerouslySkipPermissions,
  permissionMode,
  sessionKey,
}: {
  serverUrl: string
  authToken?: string
  cwd: string
  dangerouslySkipPermissions?: boolean
  permissionMode?: string
  sessionKey?: string
}): Promise<{
  config: DirectConnectConfig
  workDir?: string
}> {
  const endpoint = resolveConnectEndpoint(serverUrl)
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (authToken) {
    headers['authorization'] = `Bearer ${authToken}`
  }
  const effectiveSessionKey =
    sessionKey ?? buildDirectConnectSessionKey(serverUrl, cwd)

  let resp: Response
  try {
    const requestInit: RequestInit & { unix?: string } = {
      method: 'POST',
      headers,
      body: jsonStringify({
        cwd,
        ...(dangerouslySkipPermissions && {
          dangerously_skip_permissions: true,
        }),
        ...(permissionMode && {
          permission_mode: permissionMode,
        }),
        session_key: effectiveSessionKey,
      }),
    }
    if (endpoint.socketPath) {
      requestInit.unix = endpoint.socketPath
    }
    resp = await fetch(endpoint.url, requestInit)
  } catch (err) {
    throw new DirectConnectError(
      `Failed to connect to server at ${serverUrl}: ${errorMessage(err)}`,
    )
  }

  if (!resp.ok) {
    throw new DirectConnectError(
      `Failed to create session: ${resp.status} ${resp.statusText}`,
    )
  }

  const result = connectResponseSchema().safeParse(await resp.json())
  if (!result.success) {
    throw new DirectConnectError(
      `Invalid session response: ${result.error.message}`,
    )
  }

  const data = result.data
  return {
    config: {
      serverUrl,
      sessionId: data.session_id,
      wsUrl: resolveWsUrl(serverUrl, data.ws_url, endpoint.socketPath),
      authToken,
      socketPath: endpoint.socketPath,
    },
    workDir: data.work_dir,
  }
}

function buildDirectConnectSessionKey(serverUrl: string, cwd: string): string {
  return `direct-connect:${hashPair(serverUrl, cwd)}`
}

function resolveConnectEndpoint(serverUrl: string): {
  url: string
  socketPath?: string
} {
  if (!serverUrl.startsWith('http+unix://')) {
    return {
      url: `${serverUrl}/sessions`,
    }
  }

  return {
    url: 'http://localhost/sessions',
    socketPath: decodeUnixSocketPath(serverUrl),
  }
}

function resolveWsUrl(
  serverUrl: string,
  wsUrl: string,
  socketPath?: string,
): string {
  if (wsUrl.startsWith('/')) {
    return new URL(
      wsUrl,
      socketPath ? 'ws://localhost' : toWebSocketOrigin(serverUrl),
    ).toString()
  }
  return wsUrl
}

function toWebSocketOrigin(serverUrl: string): string {
  const parsed = new URL(serverUrl)
  const protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${parsed.host}`
}

function decodeUnixSocketPath(serverUrl: string): string {
  const parsed = new URL(serverUrl)
  const socketPath = decodeURIComponent(
    `${parsed.hostname}${parsed.pathname}` || parsed.pathname,
  ).replace(/\/$/, '')
  if (!socketPath) {
    throw new DirectConnectError(
      `Invalid unix direct-connect URL: ${serverUrl}`,
    )
  }
  return socketPath
}
