import { randomUUID } from 'crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { createReadStream } from 'fs'
import { execa } from 'execa'
import { resolve } from 'path'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import type {
  SDKControlPermissionRequest,
  SDKControlRequest,
  SDKControlResponse,
  StdoutMessage,
} from '../entrypoints/sdk/controlTypes.js'
import { ndjsonSafeStringify } from '../cli/ndjsonSafeStringify.js'
import { normalizeControlMessageKeys } from '../utils/controlMessageCompat.js'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import { isClaudeAISubscriber } from '../utils/auth.js'
import { isInBundledMode } from '../utils/bundledMode.js'
import { quote } from '../utils/bash/shellQuote.js'
import { logError } from '../utils/log.js'
import { jsonParse } from '../utils/slowOperations.js'
import type {
  SSHSessionManager,
  SSHSessionManagerCallbacks,
} from './SSHSessionManager.js'
import { startSSHAuthProxy, type SSHAuthProxy } from './sshAuthProxy.js'

const INIT_TIMEOUT_MS = 45_000
const MAX_STDERR_LINES = 120
const MAX_RECONNECT_ATTEMPTS = 3
const RECONNECT_DELAY_MS = 1_500

export class SSHSessionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SSHSessionError'
  }
}

export type SSHProxyHandle = {
  stop(): void
}

export type SSHSession = {
  remoteCwd: string
  proc: {
    readonly exitCode: number | null
    readonly signalCode: string | null
  }
  proxy: SSHProxyHandle
  createManager(callbacks: SSHSessionManagerCallbacks): SSHSessionManager
  getStderrTail(): string
}

type CreateSSHSessionOptions = {
  host: string
  cwd?: string
  localVersion?: string
  permissionMode?: string
  dangerouslySkipPermissions?: boolean
  extraCliArgs?: string[]
}

type CreateLocalSSHSessionOptions = {
  cwd?: string
  permissionMode?: string
  dangerouslySkipPermissions?: boolean
}

type CreateSSHSessionProgress = {
  onProgress?: (message: string) => void
}

type SessionMode =
  | {
      type: 'local'
      cwd: string
      permissionMode?: string
      dangerouslySkipPermissions?: boolean
    }
  | {
      type: 'remote'
      host: string
      cwd?: string
      localVersion?: string
      permissionMode?: string
      dangerouslySkipPermissions?: boolean
      extraCliArgs: string[]
    }

function delay(ms: number): Promise<void> {
  return new Promise(resolvePromise => {
    setTimeout(resolvePromise, ms)
  })
}

function buildPlaceholderAuthEnv(): Record<string, string> {
  return isClaudeAISubscriber()
    ? { CLAUDE_CODE_OAUTH_TOKEN: 'ssh-oauth-placeholder' }
    : { ANTHROPIC_API_KEY: 'ssh-api-key-placeholder' }
}

function getInheritedCliArgs(): string[] {
  const argv = process.argv.slice(2)
  const filtered: string[] = []
  const skipValueFlags = new Set([
    '--output-format',
    '--input-format',
    '--permission-prompt-tool',
    '--sdk-url',
    '--resume',
    '-r',
    '--permission-mode',
    '--prefill',
    '--deep-link-repo',
    '--deep-link-last-fetch',
  ])
  const skipBooleanFlags = new Set([
    '-p',
    '--print',
    '--verbose',
    '--replay-user-messages',
    '--enable-auth-status',
    '--continue',
    '-c',
    '--dangerously-skip-permissions',
    '--local',
    '--deep-link-origin',
  ])

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!

    if (
      arg.startsWith('--output-format=') ||
      arg.startsWith('--input-format=') ||
      arg.startsWith('--permission-prompt-tool=') ||
      arg.startsWith('--sdk-url=') ||
      arg.startsWith('--resume=') ||
      arg.startsWith('--permission-mode=') ||
      arg.startsWith('--prefill=') ||
      arg.startsWith('--deep-link-repo=') ||
      arg.startsWith('--deep-link-last-fetch=')
    ) {
      continue
    }
    if (skipBooleanFlags.has(arg)) {
      continue
    }
    if (skipValueFlags.has(arg)) {
      index += 1
      continue
    }
    filtered.push(arg)
  }

  return filtered
}

function buildPrintSessionArgs(params: {
  permissionMode?: string
  dangerouslySkipPermissions?: boolean
  resumeSessionId?: string
  extraCliArgs?: string[]
}): string[] {
  const args = [...getInheritedCliArgs()]

  if (params.resumeSessionId) {
    args.push('--resume', params.resumeSessionId)
  } else if (params.extraCliArgs?.length) {
    args.push(...params.extraCliArgs)
  }

  if (params.permissionMode) {
    args.push('--permission-mode', params.permissionMode)
  }
  if (params.dangerouslySkipPermissions) {
    args.push('--dangerously-skip-permissions')
  }

  args.push(
    '-p',
    '--verbose',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
  )

  return args
}

function getLocalClaudeInvocation(): { command: string; argv: string[] } {
  if (isInBundledMode()) {
    return { command: process.execPath, argv: [] }
  }

  const scriptPath = process.argv[1]
  if (!scriptPath) {
    throw new SSHSessionError('Cannot determine local Claude entrypoint')
  }

  return {
    command: process.execPath,
    argv: [scriptPath],
  }
}

function buildRemoteSocketPath(): string {
  return `/tmp/micro-claude-auth-${randomUUID()}.sock`
}

function buildRemoteCommand(params: {
  executable: string
  args: string[]
  cwd?: string
  socketPath: string
}): string {
  const envPairs = {
    CLAUDE_CODE_ENTRYPOINT: 'remote',
    CLAUDE_CODE_REMOTE: 'true',
    ANTHROPIC_UNIX_SOCKET: params.socketPath,
    ...buildPlaceholderAuthEnv(),
  }
  const envPrefix = Object.entries(envPairs)
    .map(([key, value]) => `${key}=${quote([value])}`)
    .join(' ')
  const execLine = `${envPrefix} ${quote([params.executable, ...params.args])}`

  if (!params.cwd) {
    return `exec ${execLine}`
  }

  return `cd ${quote([params.cwd])} && exec ${execLine}`
}

async function resolveRemoteExecutable(
  options: CreateSSHSessionOptions,
  progress?: CreateSSHSessionProgress,
): Promise<string> {
  progress?.onProgress?.('checking remote claude runtime')

  if (isInBundledMode() && process.platform === 'linux' && options.localVersion) {
    const versionKey = options.localVersion.replace(/[^A-Za-z0-9._-]/g, '_')
    const remoteDir = `$HOME/.cache/micro-claude/${versionKey}`
    const remotePath = `${remoteDir}/claude`
    const check = await execa('ssh', [
      options.host,
      'sh',
      '-lc',
      `test -x "${remotePath}"`,
    ], {
      reject: false,
    })

    if (check.exitCode !== 0) {
      progress?.onProgress?.('deploying claude bundle to remote host')
      await deployBundledBinary(options.host, remoteDir, remotePath)
    }

    return remotePath
  }

  const probe = await execa(
    'ssh',
    [options.host, 'sh', '-lc', 'command -v claude >/dev/null 2>&1'],
    {
      reject: false,
    },
  )
  if (probe.exitCode === 0) {
    return 'claude'
  }

  throw new SSHSessionError(
    'Remote host does not have `claude` installed, and this source checkout cannot deploy a portable remote binary on the current platform.',
  )
}

async function deployBundledBinary(
  host: string,
  remoteDir: string,
  remotePath: string,
): Promise<void> {
  const deployCommand =
    `umask 077 && mkdir -p "${remoteDir}" && ` +
    `cat > "${remotePath}.tmp" && ` +
    `chmod 755 "${remotePath}.tmp" && ` +
    `mv "${remotePath}.tmp" "${remotePath}"`

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn('ssh', [host, 'sh', '-lc', deployCommand], {
      stdio: ['pipe', 'ignore', 'pipe'],
    })

    let stderr = ''
    child.stderr.on('data', chunk => {
      stderr += chunk.toString()
    })
    child.once('error', reject)
    child.once('close', code => {
      if (code === 0) {
        resolvePromise()
        return
      }
      reject(
        new SSHSessionError(
          stderr.trim() || `Remote deploy failed with exit code ${code}`,
        ),
      )
    })

    createReadStream(process.execPath)
      .on('error', reject)
      .pipe(child.stdin)
  })
}

function isInitMessage(message: StdoutMessage): message is SDKMessage & {
  type: 'system'
  subtype: 'init'
  session_id: string
  cwd: string
} {
  return message.type === 'system' && message.subtype === 'init'
}

function parseStdoutLine(line: string): StdoutMessage | null {
  if (!line.trim()) {
    return null
  }

  const parsed = normalizeControlMessageKeys(jsonParse(line)) as Partial<StdoutMessage>
  if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') {
    return null
  }

  return parsed as StdoutMessage
}

class SSHRuntime {
  readonly ready: Promise<void>
  remoteCwd: string
  sessionId: string | undefined

  private callbacks: SSHSessionManagerCallbacks | null = null
  private child: ChildProcessWithoutNullStreams | null = null
  private proxy: SSHAuthProxy | null = null
  private readonly stderrLines: string[] = []
  private readonly queuedMessages: StdoutMessage[] = []
  private stopping = false
  private reconnectAttempts = 0
  private readyResolved = false
  private initCount = 0

  constructor(
    private readonly mode: SessionMode,
    remoteCwd: string,
    private readonly progress?: CreateSSHSessionProgress,
  ) {
    this.remoteCwd = remoteCwd
    this.ready = this.bootstrap()
  }

  get exitCode(): number | null {
    return this.child?.exitCode ?? null
  }

  get signalCode(): string | null {
    return (this.child?.signalCode as string | null | undefined) ?? null
  }

  getStderrTail(): string {
    return this.stderrLines.join('\n')
  }

  async stopProxy(): Promise<void> {
    this.stopping = true
    await this.killChild()
    await this.proxy?.stop()
    this.proxy = null
  }

  attach(callbacks: SSHSessionManagerCallbacks): void {
    this.callbacks = callbacks
  }

  async connect(): Promise<void> {
    try {
      await this.ready
      if (!this.callbacks) return
      this.callbacks.onConnected()
      this.flushQueuedMessages()
    } catch (error) {
      this.callbacks?.onError(
        error instanceof Error ? error : new Error(String(error)),
      )
      this.callbacks?.onDisconnected()
    }
  }

  async sendMessage(content: unknown): Promise<boolean> {
    if (!this.child || !this.sessionId) {
      return false
    }

    const payload = {
      type: 'user',
      session_id: this.sessionId,
      message: {
        role: 'user',
        content,
      },
      parent_tool_use_id: null,
      uuid: randomUUID(),
    }

    return this.writeLine(payload)
  }

  sendInterrupt(): void {
    void this.writeLine({
      type: 'control_request',
      request_id: randomUUID(),
      request: {
        subtype: 'interrupt',
      },
    } satisfies SDKControlRequest)
  }

  respondToPermissionRequest(
    requestId: string,
    response:
      | {
          behavior: 'allow'
          updatedInput?: Record<string, unknown>
        }
      | {
          behavior: 'deny'
          message?: string
        },
  ): void {
    void this.writeLine({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response:
          response.behavior === 'allow'
            ? {
                behavior: 'allow',
                updatedInput: response.updatedInput ?? {},
              }
            : {
                behavior: 'deny',
                message: response.message ?? 'Permission denied',
              },
      },
    } satisfies SDKControlResponse)
  }

  async disconnect(): Promise<void> {
    this.stopping = true
    await this.killChild()
  }

  private async bootstrap(): Promise<void> {
    this.proxy = await startSSHAuthProxy({
      exposeUnixSocket: this.mode.type === 'local',
    })

    if (this.mode.type === 'local') {
      await this.startLocalChild()
      return
    }

    await this.startRemoteChild()
  }

  private async startLocalChild(): Promise<void> {
    const socketPath = this.proxy?.unixSocketPath
    if (!socketPath) {
      throw new SSHSessionError('Local SSH proxy did not expose a unix socket')
    }

    const { command, argv } = getLocalClaudeInvocation()
    const args = [
      ...argv,
      ...buildPrintSessionArgs({
        permissionMode: this.mode.permissionMode,
        dangerouslySkipPermissions: this.mode.dangerouslySkipPermissions,
      }),
    ]

    const env = {
      ...process.env,
      CLAUDE_CODE_ENTRYPOINT: 'remote',
      CLAUDE_CODE_REMOTE: 'true',
      ANTHROPIC_UNIX_SOCKET: socketPath,
      ...buildPlaceholderAuthEnv(),
    }

    this.child = this.spawnManagedChild(command, args, {
      cwd: this.mode.cwd,
      env,
    })
  }

  private async startRemoteChild(resumeSessionId?: string): Promise<void> {
    if (this.mode.type !== 'remote') {
      throw new SSHSessionError('Remote child requested for non-remote SSH runtime')
    }

    const remoteMode = this.mode
    const remoteExecutable = await resolveRemoteExecutable(remoteMode, this.progress)
    const socketPath = buildRemoteSocketPath()
    const previousInitCount = this.initCount
    const args = buildPrintSessionArgs({
      permissionMode: remoteMode.permissionMode,
      dangerouslySkipPermissions: remoteMode.dangerouslySkipPermissions,
      extraCliArgs: remoteMode.extraCliArgs,
      resumeSessionId,
    })

    this.progress?.onProgress?.(
      resumeSessionId ? 'restarting remote session' : 'starting remote claude',
    )

    this.child = this.spawnManagedChild(
      'ssh',
      [
        '-T',
        '-o',
        'ExitOnForwardFailure=yes',
        '-o',
        'ServerAliveInterval=30',
        '-o',
        'ServerAliveCountMax=3',
        '-o',
        'StreamLocalBindUnlink=yes',
        '-R',
        `${socketPath}:127.0.0.1:${this.proxy!.localPort}`,
        remoteMode.host,
        'sh',
        '-lc',
        buildRemoteCommand({
          executable: remoteExecutable,
          args,
          cwd: remoteMode.cwd,
          socketPath,
        }),
      ],
      {},
      true,
    )

    await this.waitForInitialInit(previousInitCount)
    this.reconnectAttempts = 0
  }

  private spawnManagedChild(
    command: string,
    args: string[],
    options: {
      cwd?: string
      env?: NodeJS.ProcessEnv
    },
    requireInit = false,
  ): ChildProcessWithoutNullStreams {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdoutBuffer = ''
    let sawInit = false

    child.stdout.on('data', chunk => {
      stdoutBuffer += chunk.toString()
      let newlineIndex = stdoutBuffer.indexOf('\n')
      while (newlineIndex !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex)
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1)
        this.handleStdoutLine(line, requireInit && !this.readyResolved)
          .then(message => {
            if (!message) return
            if (isInitMessage(message)) {
              sawInit = true
              this.sessionId = message.session_id
              this.remoteCwd = message.cwd
              this.initCount += 1
            }
          })
          .catch(error => {
            this.callbacks?.onError(
              error instanceof Error ? error : new Error(String(error)),
            )
          })
        newlineIndex = stdoutBuffer.indexOf('\n')
      }
    })

    child.stderr.on('data', chunk => {
      const text = chunk.toString().replace(/\r?\n$/, '')
      if (!text) return
      this.stderrLines.push(...text.split(/\r?\n/))
      if (this.stderrLines.length > MAX_STDERR_LINES) {
        this.stderrLines.splice(0, this.stderrLines.length - MAX_STDERR_LINES)
      }
    })

    child.once('error', error => {
      this.callbacks?.onError(error)
    })

    child.once('close', (code, signal) => {
      if (!this.stopping && (!requireInit || sawInit)) {
        void this.handleChildExit(code, signal)
      }
    })

    return child
  }

  private async waitForInitialInit(previousInitCount: number): Promise<void> {
    const child = this.child
    if (!child) {
      throw new SSHSessionError('SSH child process did not start')
    }

    await new Promise<void>((resolvePromise, reject) => {
      const started = Date.now()
      const tick = () => {
        if (this.initCount > previousInitCount) {
          this.readyResolved = true
          resolvePromise()
          return
        }
        if (child.exitCode !== null) {
          reject(
            new SSHSessionError(
              this.getStderrTail().trim() ||
                `SSH process exited after ${Date.now() - started}ms without init`,
            ),
          )
          return
        }
        if (Date.now() - started > INIT_TIMEOUT_MS) {
          reject(
            new SSHSessionError(
              `Timed out waiting for remote SSH session init${this.getStderrTail() ? `:\n${this.getStderrTail()}` : ''}`,
            ),
          )
          return
        }
        setTimeout(tick, 50)
      }
      tick()
    })
  }

  private async handleStdoutLine(
    line: string,
    suppressFirstInit: boolean,
  ): Promise<StdoutMessage | null> {
    let message: StdoutMessage | null = null
    try {
      message = parseStdoutLine(line)
    } catch (error) {
      logForDebugging(
        `[ssh] ignoring non-JSON stdout line: ${line.slice(0, 200)}`,
        { level: 'warn' },
      )
      return null
    }

    if (!message || message.type === 'keep_alive') {
      return null
    }

    if (isInitMessage(message)) {
      this.sessionId = message.session_id
      this.remoteCwd = message.cwd
      if (suppressFirstInit && !this.callbacks) {
        return message
      }
    }

    this.dispatchMessage(message)
    return message
  }

  private dispatchMessage(message: StdoutMessage): void {
    if (!this.callbacks) {
      this.queuedMessages.push(message)
      return
    }

    switch (message.type) {
      case 'control_request':
        if (message.request.subtype === 'can_use_tool') {
          this.callbacks.onPermissionRequest(
            message.request as SDKControlPermissionRequest,
            message.request_id,
          )
          return
        }
        this.respondUnsupportedControlRequest(message)
        return
      case 'control_cancel_request':
      case 'control_response':
        return
      default:
        this.callbacks.onMessage(message as SDKMessage)
    }
  }

  private respondUnsupportedControlRequest(request: SDKControlRequest): void {
    void this.writeLine({
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: request.request_id,
        error: `Unsupported SSH control request subtype: ${request.request.subtype}`,
      },
    } satisfies SDKControlResponse)
  }

  private flushQueuedMessages(): void {
    if (!this.callbacks) return
    for (const message of this.queuedMessages.splice(0)) {
      this.dispatchMessage(message)
    }
  }

  private async handleChildExit(
    _code: number | null,
    _signal: NodeJS.Signals | null,
  ): Promise<void> {
    if (!this.callbacks) {
      return
    }
    if (!this.sessionId || this.mode.type !== 'remote') {
      this.callbacks.onDisconnected()
      return
    }
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.callbacks.onDisconnected()
      return
    }

    this.reconnectAttempts += 1
    this.callbacks.onReconnecting(
      this.reconnectAttempts,
      MAX_RECONNECT_ATTEMPTS,
    )

    try {
      await delay(RECONNECT_DELAY_MS * this.reconnectAttempts)
      await this.startRemoteChild(this.sessionId)
      this.callbacks.onConnected()
      this.flushQueuedMessages()
    } catch (error) {
      this.callbacks.onError(
        error instanceof Error ? error : new Error(String(error)),
      )
      if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        this.callbacks.onDisconnected()
        return
      }
      await this.handleChildExit(null, null)
    }
  }

  private async killChild(): Promise<void> {
    const child = this.child
    this.child = null
    if (!child) return
    if (child.killed) return

    child.kill('SIGTERM')
    await Promise.race([
      new Promise(resolvePromise => {
        child.once('close', resolvePromise)
      }),
      delay(2_000).then(() => {
        if (!child.killed) {
          child.kill('SIGKILL')
        }
      }),
    ])
  }

  private async writeLine(message: unknown): Promise<boolean> {
    if (!this.child?.stdin.writable) {
      return false
    }

    return await new Promise<boolean>(resolvePromise => {
      const payload = ndjsonSafeStringify(message) + '\n'
      this.child!.stdin.write(payload, error => {
        if (error) {
          this.callbacks?.onError(
            error instanceof Error ? error : new Error(String(error)),
          )
          resolvePromise(false)
          return
        }
        resolvePromise(true)
      })
    })
  }
}

function createSession(runtime: SSHRuntime): SSHSession {
  return {
    get remoteCwd() {
      return runtime.remoteCwd
    },
    proc: {
      get exitCode() {
        return runtime.exitCode
      },
      get signalCode() {
        return runtime.signalCode
      },
    },
    proxy: {
      stop() {
        void runtime.stopProxy().catch(logError)
      },
    },
    createManager(callbacks: SSHSessionManagerCallbacks): SSHSessionManager {
      runtime.attach(callbacks)
      return {
        connect() {
          void runtime.connect()
        },
        disconnect() {
          void runtime.disconnect().catch(logError)
        },
        sendMessage(content) {
          return runtime.sendMessage(content)
        },
        sendInterrupt() {
          runtime.sendInterrupt()
        },
        respondToPermissionRequest(requestId, response) {
          runtime.respondToPermissionRequest(requestId, response)
        },
      }
    },
    getStderrTail() {
      return runtime.getStderrTail()
    },
  }
}

export async function createSSHSession(
  options: CreateSSHSessionOptions,
  progress?: CreateSSHSessionProgress,
): Promise<SSHSession> {
  let runtime: SSHRuntime | undefined
  try {
    runtime = new SSHRuntime(
      {
        type: 'remote',
        host: options.host,
        cwd: options.cwd,
        localVersion: options.localVersion,
        permissionMode: options.permissionMode,
        dangerouslySkipPermissions: options.dangerouslySkipPermissions,
        extraCliArgs: options.extraCliArgs ?? [],
      },
      '',
      progress,
    )
    await runtime.ready
    return createSession(runtime)
  } catch (error) {
    await runtime?.stopProxy().catch(() => {})
    throw new SSHSessionError(errorMessage(error))
  }
}

export function createLocalSSHSession(
  options: CreateLocalSSHSessionOptions,
): SSHSession {
  const runtime = new SSHRuntime(
    {
      type: 'local',
      cwd: resolve(options.cwd ?? process.cwd()),
      permissionMode: options.permissionMode,
      dangerouslySkipPermissions: options.dangerouslySkipPermissions,
    },
    resolve(options.cwd ?? process.cwd()),
  )
  void runtime.ready.catch(error => {
    logError(error instanceof Error ? error : new Error(String(error)))
  })
  return createSession(runtime)
}
