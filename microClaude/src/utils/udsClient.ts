import { readdir, readFile, unlink } from 'fs/promises'
import { createConnection } from 'net'
import { join } from 'path'
import { logForDebugging } from './debug.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { errorMessage, isFsInaccessible } from './errors.js'
import { isProcessRunning } from './genericProcessUtils.js'
import { getPlatform } from './platform.js'
import { jsonParse, jsonStringify } from './slowOperations.js'

export type LiveSessionInfo = {
  pid: number
  sessionId?: string
  cwd?: string
  startedAt?: number
  updatedAt?: number
  kind?: string
  name?: string
  entrypoint?: string
  messagingSocketPath?: string
  bridgeSessionId?: string | null
}

type SessionRecord = LiveSessionInfo

function getSessionsDir(): string {
  return join(getClaudeConfigHomeDir(), 'sessions')
}

export async function sendToUdsSocket(
  socketPath: string,
  message: string,
): Promise<void> {
  if (!socketPath) {
    throw new Error('UDS socket path is required')
  }

  const fromSocketPath = process.env.CLAUDE_CODE_MESSAGING_SOCKET
  const payload = jsonStringify({
    type: 'enqueue',
    from: fromSocketPath ? `uds:${fromSocketPath}` : undefined,
    message,
  })

  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(socketPath)
    let settled = false

    const finish = (cb: () => void): void => {
      if (settled) return
      settled = true
      cb()
    }

    socket.setTimeout(5_000)
    socket.on('connect', () => {
      socket.end(payload)
    })
    socket.on('close', hadError => {
      if (!hadError) {
        finish(resolve)
      }
    })
    socket.on('timeout', () => {
      socket.destroy()
      finish(() => reject(new Error('Timed out connecting to peer socket')))
    })
    socket.on('error', e => {
      socket.destroy()
      finish(() => reject(e))
    })
  })
}

export async function listAllLiveSessions(): Promise<LiveSessionInfo[]> {
  const dir = getSessionsDir()
  let files: string[]

  try {
    files = await readdir(dir)
  } catch (e) {
    if (!isFsInaccessible(e)) {
      logForDebugging(`[uds:client] Failed to read sessions dir: ${errorMessage(e)}`)
    }
    return []
  }

  const sessions: LiveSessionInfo[] = []

  for (const file of files) {
    if (!/^\d+\.json$/.test(file)) {
      continue
    }

    const pid = Number.parseInt(file.slice(0, -5), 10)
    if (pid !== process.pid && !isProcessRunning(pid)) {
      if (getPlatform() !== 'wsl') {
        void unlink(join(dir, file)).catch(() => {})
      }
      continue
    }

    try {
      const raw = await readFile(join(dir, file), 'utf8')
      const parsed = jsonParse(raw) as SessionRecord
      if (!parsed || typeof parsed !== 'object') {
        continue
      }

      sessions.push({
        pid,
        sessionId:
          typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined,
        cwd: typeof parsed.cwd === 'string' ? parsed.cwd : undefined,
        startedAt:
          typeof parsed.startedAt === 'number' ? parsed.startedAt : undefined,
        updatedAt:
          typeof parsed.updatedAt === 'number' ? parsed.updatedAt : undefined,
        kind: typeof parsed.kind === 'string' ? parsed.kind : undefined,
        name: typeof parsed.name === 'string' ? parsed.name : undefined,
        entrypoint:
          typeof parsed.entrypoint === 'string' ? parsed.entrypoint : undefined,
        messagingSocketPath:
          typeof parsed.messagingSocketPath === 'string'
            ? parsed.messagingSocketPath
            : undefined,
        bridgeSessionId:
          typeof parsed.bridgeSessionId === 'string' || parsed.bridgeSessionId === null
            ? parsed.bridgeSessionId
            : undefined,
      })
    } catch (e) {
      logForDebugging(
        `[uds:client] Failed to read session record ${file}: ${errorMessage(e)}`,
      )
    }
  }

  return sessions.sort(
    (a, b) => (b.updatedAt ?? b.startedAt ?? 0) - (a.updatedAt ?? a.startedAt ?? 0),
  )
}
