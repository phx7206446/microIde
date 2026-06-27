import { randomUUID } from 'crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { tmpdir } from 'os'
import { join } from 'path'
import { Readable } from 'stream'
import { getAuthHeaders } from '../utils/http.js'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import { logError } from '../utils/log.js'

export type SSHAuthProxy = {
  localPort: number
  unixSocketPath?: string
  stop(): Promise<void>
}

function buildSocketPath(): string {
  const id = randomUUID()
  if (process.platform === 'win32') {
    return `\\\\?\\pipe\\micro-claude-ssh-auth-${id}`
  }
  return join(tmpdir(), `micro-claude-ssh-auth-${id}.sock`)
}

async function listenOn(
  server: ReturnType<typeof createServer>,
  options: Parameters<typeof server.listen>[0],
  host?: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }

    server.once('error', onError)
    server.once('listening', onListening)
    if (typeof options === 'number') {
      server.listen(options, host)
    } else {
      server.listen(options)
    }
  })
}

async function closeServer(
  server: ReturnType<typeof createServer> | null,
): Promise<void> {
  if (!server) return
  await new Promise<void>((resolve, reject) => {
    server.close(error => {
      if (error) reject(error)
      else resolve()
    })
  })
}

function mergeHeaderValues(
  existing: string | undefined,
  next: string | undefined,
): string | undefined {
  if (!existing) return next
  if (!next) return existing
  const tokens = new Set(
    `${existing},${next}`
      .split(',')
      .map(token => token.trim())
      .filter(Boolean),
  )
  return Array.from(tokens).join(',')
}

async function readRequestBody(req: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  if (chunks.length === 0) return undefined
  return Buffer.concat(chunks)
}

function copyResponseHeaders(
  response: Response,
  res: ServerResponse<IncomingMessage>,
): void {
  for (const [name, value] of response.headers.entries()) {
    if (name.toLowerCase() === 'transfer-encoding') continue
    res.setHeader(name, value)
  }
}

function buildForwardHeaders(req: IncomingMessage): Record<string, string> {
  const forwarded: Record<string, string> = {}
  for (const [name, value] of Object.entries(req.headers)) {
    if (!value) continue
    const key = name.toLowerCase()
    if (
      key === 'host' ||
      key === 'content-length' ||
      key === 'connection' ||
      key === 'authorization' ||
      key === 'x-api-key'
    ) {
      continue
    }
    forwarded[name] = Array.isArray(value) ? value.join(', ') : value
  }
  return forwarded
}

async function handleProxyRequest(
  req: IncomingMessage,
  res: ServerResponse<IncomingMessage>,
): Promise<void> {
  try {
    const auth = getAuthHeaders()
    if (auth.error) {
      res.statusCode = 401
      res.end(auth.error)
      return
    }

    const target = new URL(req.url || '/', 'https://api.anthropic.com')
    const headers = buildForwardHeaders(req)
    const mergedBeta = mergeHeaderValues(
      headers['anthropic-beta'] ?? headers['Anthropic-Beta'],
      auth.headers['anthropic-beta'],
    )
    if (mergedBeta) {
      headers['anthropic-beta'] = mergedBeta
    }
    delete headers['Anthropic-Beta']

    for (const [key, value] of Object.entries(auth.headers)) {
      if (key.toLowerCase() === 'anthropic-beta') continue
      headers[key] = value
    }

    const body = await readRequestBody(req)
    const response = await fetch(target, {
      method: req.method,
      headers,
      body: body ? new Uint8Array(body) : undefined,
    })

    res.statusCode = response.status
    res.statusMessage = response.statusText
    copyResponseHeaders(response, res)

    if (!response.body) {
      res.end()
      return
    }

    Readable.fromWeb(response.body as globalThis.ReadableStream<Uint8Array>)
      .on('error', error => {
        logError(error instanceof Error ? error : new Error(String(error)))
        if (!res.headersSent) {
          res.statusCode = 502
        }
        res.end()
      })
      .pipe(res)
  } catch (error) {
    logError(error instanceof Error ? error : new Error(String(error)))
    res.statusCode = 502
    res.end(errorMessage(error))
  }
}

export async function startSSHAuthProxy(
  options: { exposeUnixSocket?: boolean } = {},
): Promise<SSHAuthProxy> {
  const auth = getAuthHeaders()
  if (auth.error) {
    throw new Error(auth.error)
  }

  const tcpServer = createServer((req, res) => {
    void handleProxyRequest(req, res)
  })
  await listenOn(tcpServer, 0, '127.0.0.1')

  let unixServer: ReturnType<typeof createServer> | null = null
  let unixSocketPath: string | undefined

  if (options.exposeUnixSocket) {
    unixSocketPath = buildSocketPath()
    unixServer = createServer((req, res) => {
      void handleProxyRequest(req, res)
    })
    await listenOn(unixServer, unixSocketPath)
  }

  const address = tcpServer.address()
  if (!address || typeof address === 'string') {
    throw new Error('Failed to determine SSH auth proxy port')
  }

  logForDebugging(
    `[sshAuthProxy] listening on 127.0.0.1:${address.port}${unixSocketPath ? ` and ${unixSocketPath}` : ''}`,
  )

  return {
    localPort: address.port,
    unixSocketPath,
    async stop() {
      await Promise.allSettled([closeServer(tcpServer), closeServer(unixServer)])
    },
  }
}
