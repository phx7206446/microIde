import { createConnection, createServer, type Server, type Socket } from 'net'
import { rmSync } from 'fs'
import { dirname, join } from 'path'

const AGENT_VIEW_JOB_ID_ENV = 'CLAUDE_CODE_AGENT_VIEW_JOB_ID'
const AGENT_VIEW_JOB_STATE_ENV = 'CLAUDE_CODE_AGENT_VIEW_STATE_PATH'
const AGENT_VIEW_CONTROL_RETRY_MS = 5_000

export type AgentViewControlMessage =
  | { type: 'set_input'; text: string; cursor: number }
  | { type: 'submit'; text: string }

export function getAgentViewControlSocketPath(
  jobId: string,
  statePath?: string,
): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\microclaude-agent-control-${jobId}`
  }
  return join(dirname(statePath ?? ''), 'control.sock')
}

export function writeAgentViewControlMessage(
  socket: Socket,
  message: AgentViewControlMessage,
): void {
  socket.write(`${JSON.stringify(message)}\n`, 'utf8')
}

export async function sendAgentViewControlMessage(
  jobId: string,
  message: AgentViewControlMessage,
  options: { statePath?: string; retryMs?: number } = {},
): Promise<void> {
  const socketPath = getAgentViewControlSocketPath(jobId, options.statePath)
  const deadline = Date.now() + (options.retryMs ?? AGENT_VIEW_CONTROL_RETRY_MS)
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection(socketPath)
        socket.once('connect', () => {
          writeAgentViewControlMessage(socket, message)
          socket.end()
        })
        socket.once('error', reject)
        socket.once('close', hadError => {
          if (hadError) return
          resolve()
        })
      })
      return
    } catch (error) {
      lastError = error
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('Agent View control prompt delivery failed.')
}

export function startAgentViewControlServer(
  onMessage: (message: AgentViewControlMessage) => void,
): (() => void) | undefined {
  const jobId = process.env[AGENT_VIEW_JOB_ID_ENV]
  const statePath = process.env[AGENT_VIEW_JOB_STATE_ENV]
  if (!jobId || !statePath) return undefined

  const socketPath = getAgentViewControlSocketPath(jobId, statePath)
  if (process.platform !== 'win32') {
    try {
      rmSync(socketPath, { force: true })
    } catch {
      // Stale Unix sockets are best-effort cleanup only.
    }
  }

  const sockets = new Set<Socket>()
  const server: Server = createServer(socket => {
    sockets.add(socket)
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', chunk => {
      buffer += chunk
      while (true) {
        const index = buffer.indexOf('\n')
        if (index === -1) break
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        try {
          const message = JSON.parse(line) as Partial<AgentViewControlMessage>
          if (
            message.type === 'set_input' &&
            typeof message.text === 'string' &&
            typeof message.cursor === 'number' &&
            Number.isFinite(message.cursor) &&
            message.cursor >= 0
          ) {
            onMessage({
              type: 'set_input',
              text: message.text,
              cursor: Math.trunc(message.cursor),
            })
          } else if (
            message.type === 'submit' &&
            typeof message.text === 'string' &&
            message.text.trim().length > 0
          ) {
            onMessage({ type: 'submit', text: message.text })
          }
        } catch {
          // Ignore malformed control messages from stale clients.
        }
      }
    })
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => sockets.delete(socket))
  })
  server.on('error', () => {})
  server.listen(socketPath)

  return () => {
    for (const socket of sockets) socket.destroy()
    server.close()
    if (process.platform !== 'win32') {
      try {
        rmSync(socketPath, { force: true })
      } catch {
        // Best-effort cleanup.
      }
    }
  }
}
