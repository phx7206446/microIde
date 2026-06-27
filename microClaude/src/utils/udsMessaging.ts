import { chmod, mkdir, unlink } from 'fs/promises'
import { createServer, type Server, type Socket } from 'net'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { getSessionId } from '../bootstrap/state.js'
import { CROSS_SESSION_MESSAGE_TAG } from '../constants/xml.js'
import { registerCleanup } from './cleanupRegistry.js'
import { logForDebugging } from './debug.js'
import { errorMessage, isENOENT } from './errors.js'
import { enqueue } from './messageQueueManager.js'
import { escapeXml, escapeXmlAttr } from './xml.js'

type StartUdsMessagingOptions = {
  isExplicit?: boolean
}

type UdsEnvelope = {
  type: 'enqueue'
  message: string
  from?: string
}

let server: Server | null = null
let activeSocketPath: string | undefined
let onEnqueue: (() => void) | undefined
let cleanupRegistered = false

function isWindowsPipePath(socketPath: string): boolean {
  return process.platform === 'win32' || socketPath.startsWith('\\\\.\\pipe\\')
}

function normalizeCrossSessionMessage(message: string, from?: string): string {
  if (!from) {
    return message
  }

  return `<${CROSS_SESSION_MESSAGE_TAG} from="${escapeXmlAttr(from)}">${escapeXml(message)}</${CROSS_SESSION_MESSAGE_TAG}>`
}

async function cleanupSocketPath(socketPath: string): Promise<void> {
  if (isWindowsPipePath(socketPath)) {
    return
  }

  try {
    await unlink(socketPath)
  } catch (e) {
    if (!isENOENT(e)) {
      logForDebugging(
        `[uds:server] Failed to remove socket ${socketPath}: ${errorMessage(e)}`,
      )
    }
  }
}

function handleClient(socket: Socket): void {
  const chunks: string[] = []
  socket.setEncoding('utf8')

  socket.on('data', chunk => {
    chunks.push(String(chunk))
  })

  socket.on('end', () => {
    const raw = chunks.join('').trim()
    if (!raw) {
      return
    }

    try {
      const payload = JSON.parse(raw) as UdsEnvelope
      if (payload.type !== 'enqueue' || typeof payload.message !== 'string') {
        return
      }

      enqueue({
        mode: 'prompt',
        value: normalizeCrossSessionMessage(payload.message, payload.from),
        skipSlashCommands: true,
      })
      onEnqueue?.()
    } catch (e) {
      logForDebugging(
        `[uds:server] Failed to parse inbound payload: ${errorMessage(e)}`,
      )
    }
  })

  socket.on('error', e => {
    logForDebugging(`[uds:server] Client socket error: ${errorMessage(e)}`)
  })
}

function ensureCleanupRegistered(): void {
  if (cleanupRegistered) {
    return
  }

  cleanupRegistered = true
  registerCleanup(async () => {
    const closingServer = server
    const socketPath = activeSocketPath
    server = null
    activeSocketPath = undefined

    if (closingServer) {
      await new Promise<void>(resolve => {
        closingServer.close(() => resolve())
      }).catch(() => {})
    }

    if (socketPath) {
      await cleanupSocketPath(socketPath)
    }
  })
}

export function getDefaultUdsSocketPath(): string {
  const sessionId = getSessionId().replace(/[^a-zA-Z0-9_-]/g, '_')
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\claude-code-${sessionId}`
  }

  return join(tmpdir(), 'claude-code-sockets', `${sessionId}.sock`)
}

export function getUdsMessagingSocketPath(): string | undefined {
  return activeSocketPath ?? process.env.CLAUDE_CODE_MESSAGING_SOCKET
}

export function setOnEnqueue(callback: (() => void) | undefined): void {
  onEnqueue = callback
}

export async function startUdsMessaging(
  socketPath: string,
  options: StartUdsMessagingOptions = {},
): Promise<void> {
  if (server && activeSocketPath === socketPath) {
    process.env.CLAUDE_CODE_MESSAGING_SOCKET = socketPath
    return
  }

  if (server) {
    const oldServer = server
    const oldSocketPath = activeSocketPath
    server = null
    activeSocketPath = undefined
    await new Promise<void>(resolve => {
      oldServer.close(() => resolve())
    })
    if (oldSocketPath) {
      await cleanupSocketPath(oldSocketPath)
    }
  }

  if (!isWindowsPipePath(socketPath)) {
    await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 })
    if (!options.isExplicit) {
      await cleanupSocketPath(socketPath)
    }
  }

  const nextServer = createServer(handleClient)
  nextServer.on('error', e => {
    logForDebugging(`[uds:server] Server error: ${errorMessage(e)}`)
  })

  await new Promise<void>((resolve, reject) => {
    nextServer.once('error', reject)
    nextServer.listen(socketPath, () => {
      nextServer.off('error', reject)
      resolve()
    })
  })

  if (!isWindowsPipePath(socketPath)) {
    await chmod(socketPath, 0o600).catch(() => {})
  }

  server = nextServer
  activeSocketPath = socketPath
  process.env.CLAUDE_CODE_MESSAGING_SOCKET = socketPath
  ensureCleanupRegistered()
}
