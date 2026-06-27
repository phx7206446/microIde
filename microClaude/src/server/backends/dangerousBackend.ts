import { randomUUID } from 'crypto'
import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'child_process'
import { isInBundledMode } from '../../utils/bundledMode.js'
import { errorMessage } from '../../utils/errors.js'

const READY_TIMEOUT_MS = 10_000
const FORCE_KILL_TIMEOUT_MS = 2_000

export type DangerousBackendCreateSessionOptions = {
  cwd: string
  dangerouslySkipPermissions?: boolean
  permissionMode?: string
  resumeSessionId?: string
}

export type BackendSessionReady = {
  sessionId: string
  workDir: string
}

export type BackendSession = {
  waitUntilReady(): Promise<BackendSessionReady>
  onLine(listener: (line: string) => void): () => void
  onExit(
    listener: (event: {
      code: number | null
      signal: NodeJS.Signals | null
      error?: Error
    }) => void,
  ): () => void
  sendLine(line: string): boolean
  destroy(): Promise<void>
}

function getLocalClaudeInvocation(): { command: string; argv: string[] } {
  if (isInBundledMode()) {
    return {
      command: process.execPath,
      argv: [],
    }
  }

  const scriptPath = process.argv[1]
  if (!scriptPath) {
    throw new Error('Unable to determine the local Claude entrypoint')
  }

  return {
    command: process.execPath,
    argv: [scriptPath],
  }
}

class DangerousSession implements BackendSession {
  private readonly stdoutListeners = new Set<(line: string) => void>()
  private readonly exitListeners = new Set<
    (event: {
      code: number | null
      signal: NodeJS.Signals | null
      error?: Error
    }) => void
  >()
  private readonly child: ChildProcessWithoutNullStreams
  private readyResult?: BackendSessionReady
  private readyPromise: Promise<BackendSessionReady>
  private readyResolve: (value: BackendSessionReady) => void = () => {}
  private readyReject: (reason?: unknown) => void = () => {}
  private readyTimer: NodeJS.Timeout
  private destroying = false
  private stderrTail = ''

  constructor(
    options: DangerousBackendCreateSessionOptions,
  ) {
    const sessionId = options.resumeSessionId ?? randomUUID()
    const invocation = getLocalClaudeInvocation()
    const args = [
      ...invocation.argv,
      '--print',
      '--verbose',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--replay-user-messages',
      ...(options.resumeSessionId
        ? ['--resume', options.resumeSessionId]
        : ['--session-id', sessionId]),
      ...(options.permissionMode
        ? ['--permission-mode', options.permissionMode]
        : []),
      ...(options.dangerouslySkipPermissions
        ? ['--dangerously-skip-permissions']
        : []),
    ]

    let resolveReady!: (value: BackendSessionReady) => void
    let rejectReady!: (reason?: unknown) => void
    this.readyPromise = new Promise<BackendSessionReady>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    this.readyResolve = resolveReady
    this.readyReject = rejectReady

    this.child = spawn(invocation.command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    this.readyTimer = setTimeout(() => {
      this.readyReject(
        new Error(
          this.stderrTail.trim()
            ? `Timed out waiting for session spawn:\n${this.stderrTail.trim()}`
            : 'Timed out waiting for session spawn',
        ),
      )
    }, READY_TIMEOUT_MS)

    this.child.once('spawn', () => {
      if (this.readyResult) {
        return
      }
      this.readyResult = {
        sessionId,
        workDir: options.cwd,
      }
      clearTimeout(this.readyTimer)
      this.readyResolve(this.readyResult)
    })

    let stdoutBuffer = ''
    this.child.stdout.on('data', chunk => {
      stdoutBuffer += chunk.toString()
      let newlineIndex = stdoutBuffer.indexOf('\n')
      while (newlineIndex !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex)
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1)
        this.handleStdoutLine(line)
        newlineIndex = stdoutBuffer.indexOf('\n')
      }
    })

    this.child.stderr.on('data', chunk => {
      const text = chunk.toString()
      this.stderrTail = `${this.stderrTail}${text}`.slice(-4_096)
    })

    this.child.once('error', error => {
      this.readyReject(error)
      this.emitExit({
        code: null,
        signal: null,
        error,
      })
    })

    this.child.once('close', (code, signal) => {
      if (!this.readyResult) {
        this.readyReject(
          new Error(
            this.stderrTail.trim() ||
              `Session process exited before spawn (code=${code}, signal=${signal ?? 'none'})`,
          ),
        )
      }
      this.emitExit({ code, signal })
    })
  }

  waitUntilReady(): Promise<BackendSessionReady> {
    return this.readyPromise
  }

  onLine(listener: (line: string) => void): () => void {
    this.stdoutListeners.add(listener)
    return () => {
      this.stdoutListeners.delete(listener)
    }
  }

  onExit(
    listener: (event: {
      code: number | null
      signal: NodeJS.Signals | null
      error?: Error
    }) => void,
  ): () => void {
    this.exitListeners.add(listener)
    return () => {
      this.exitListeners.delete(listener)
    }
  }

  sendLine(line: string): boolean {
    if (!this.child.stdin.writable) {
      return false
    }
    this.child.stdin.write(line.endsWith('\n') ? line : `${line}\n`)
    return true
  }

  async destroy(): Promise<void> {
    if (this.destroying) {
      return
    }
    this.destroying = true
    clearTimeout(this.readyTimer)

    if (this.child.killed || this.child.exitCode !== null) {
      return
    }

    if (process.platform === 'win32') {
      this.child.kill()
      return
    }

    this.child.kill('SIGTERM')
    await Promise.race([
      new Promise(resolve => {
        this.child.once('close', resolve)
      }),
      new Promise(resolve => {
        setTimeout(resolve, FORCE_KILL_TIMEOUT_MS)
      }).then(() => {
        if (this.child.exitCode === null) {
          this.child.kill('SIGKILL')
        }
      }),
    ])
  }

  private handleStdoutLine(line: string): void {
    if (!line.trim()) {
      return
    }

    for (const listener of this.stdoutListeners) {
      listener(line)
    }
  }

  private emitExit(event: {
    code: number | null
    signal: NodeJS.Signals | null
    error?: Error
  }): void {
    clearTimeout(this.readyTimer)
    for (const listener of this.exitListeners) {
      listener(event)
    }
  }
}

export class DangerousBackend {
  createSession(options: DangerousBackendCreateSessionOptions): BackendSession {
    try {
      return new DangerousSession(options)
    } catch (error) {
      throw new Error(errorMessage(error))
    }
  }
}
