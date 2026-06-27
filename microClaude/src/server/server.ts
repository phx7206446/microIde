import { randomUUID } from 'crypto'
import { z } from 'zod/v4'
import { jsonStringify } from '../utils/slowOperations.js'
import type { SessionClient } from './sessionManager.js'
import {
  SessionManager,
  SessionManagerError,
} from './sessionManager.js'
import type { ServerLogger } from './serverLog.js'
import type { ServerConfig } from './types.js'

const createSessionSchema = z.object({
  cwd: z.string().optional(),
  dangerously_skip_permissions: z.boolean().optional(),
  permission_mode: z.string().optional(),
  session_key: z.string().min(1).optional(),
})

type SocketData = {
  clientId: string
  sessionId: string
}

type BunWebSocket<T> = {
  data: T
  send(data: string | ArrayBuffer | ArrayBufferView): unknown
  close(code?: number, reason?: string): void
}

type ClaudeServerHandle = {
  port?: number
  stop(force?: boolean): void
  upgrade(
    request: Request,
    options?: {
      data?: SocketData
      headers?: HeadersInit
    },
  ): boolean
}

type BunServeLike = {
  serve(options: {
    port?: number
    hostname?: string
    unix?: string
    fetch(
      request: Request,
      server: ClaudeServerHandle,
    ): Response | Promise<Response> | undefined
    websocket: {
      open?(ws: BunWebSocket<SocketData>): void | Promise<void>
      message(
        ws: BunWebSocket<SocketData>,
        message: string | Buffer,
      ): void | Promise<void>
      close?(
        ws: BunWebSocket<SocketData>,
        code: number,
        reason: string,
      ): void | Promise<void>
    }
  }): ClaudeServerHandle
}

export function startServer(
  config: ServerConfig,
  sessionManager: SessionManager,
  logger: ServerLogger,
): ClaudeServerHandle {
  const bun = Bun as unknown as BunServeLike
  return bun.serve({
    port: config.unix ? undefined : config.port,
    hostname: config.unix ? undefined : config.host,
    unix: config.unix,
    fetch: async (request, server) => {
      const url = new URL(request.url)

      if (request.method === 'GET' && url.pathname === '/health') {
        return jsonResponse({ ok: true })
      }

      if (!isAuthorized(request, config.authToken)) {
        return textResponse('Unauthorized', 401)
      }

      if (request.method === 'POST' && url.pathname === '/sessions') {
        try {
          const body = createSessionSchema.parse(await request.json())
          const cwd = body.cwd ?? config.workspace ?? process.cwd()
          const session = await sessionManager.createSession({
            cwd,
            dangerouslySkipPermissions: body.dangerously_skip_permissions,
            permissionMode: body.permission_mode,
            sessionKey: body.session_key,
          })
          logger.info(`Created session ${session.sessionId} in ${session.workDir}`)
          return jsonResponse({
            session_id: session.sessionId,
            ws_url: buildSessionWebSocketUrl(request.url, session.sessionId),
            work_dir: session.workDir,
          })
        } catch (error) {
          if (error instanceof SessionManagerError) {
            logger.warn(error.message)
            return textResponse(error.message, error.status)
          }
          if (error instanceof z.ZodError) {
            return textResponse(error.message, 400)
          }
          logger.error('Failed to create session', error)
          return textResponse('Failed to create session', 500)
        }
      }

      if (request.method === 'GET') {
        const match = /^\/sessions\/([^/]+)\/ws$/.exec(url.pathname)
        if (match) {
          const sessionId = decodeURIComponent(match[1]!)
          if (!sessionManager.hasSession(sessionId)) {
            return textResponse('Unknown session', 404)
          }
          if (!sessionManager.canAttach(sessionId)) {
            return textResponse('Session already has an attached client', 409)
          }
          const upgraded = server.upgrade(request, {
            data: {
              clientId: randomUUID(),
              sessionId,
            },
          })
          if (upgraded) {
            return
          }
          return textResponse('Failed to upgrade websocket', 500)
        }
      }

      return textResponse('Not found', 404)
    },
    websocket: {
      open: ws => {
        const client = createSessionClient(ws)
        try {
          sessionManager.attachClient(ws.data.sessionId, client)
        } catch (error) {
          const status =
            error instanceof SessionManagerError ? error.status : 1011
          ws.close(status, error instanceof Error ? error.message : 'Attach failed')
        }
      },
      message: (ws, message) => {
        const ok = sessionManager.handleClientMessage(
          ws.data.sessionId,
          messageToString(message),
        )
        if (!ok) {
          ws.close(1011, 'Session is no longer available')
        }
      },
      close: ws => {
        sessionManager.detachClient(ws.data.sessionId, ws.data.clientId)
      },
    },
  })
}

function createSessionClient(
  ws: BunWebSocket<SocketData>,
): SessionClient {
  return {
    id: ws.data.clientId,
    send(line: string) {
      ws.send(line)
    },
    close(code?: number, reason?: string) {
      ws.close(code, reason)
    },
  }
}

function isAuthorized(request: Request, authToken: string): boolean {
  return request.headers.get('authorization') === `Bearer ${authToken}`
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(jsonStringify(data), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  })
}

function textResponse(message: string, status: number): Response {
  return new Response(message, { status })
}

function buildSessionWebSocketUrl(
  requestUrl: string,
  sessionId: string,
): string {
  const url = new URL(requestUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = `/sessions/${encodeURIComponent(sessionId)}/ws`
  url.search = ''
  url.hash = ''
  return url.toString()
}

function messageToString(
  message: string | Buffer | ArrayBuffer | Uint8Array,
): string {
  if (typeof message === 'string') {
    return message
  }
  if (Buffer.isBuffer(message)) {
    return message.toString('utf8')
  }
  if (message instanceof Uint8Array) {
    return Buffer.from(message).toString('utf8')
  }
  return Buffer.from(message).toString('utf8')
}
