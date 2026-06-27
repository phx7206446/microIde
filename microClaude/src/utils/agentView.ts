import { spawn } from 'child_process'
import { createServer as createHttpServer, request, type IncomingMessage, type ServerResponse } from 'http'
import {
  createConnection,
  createServer as createNetServer,
  type Server as NetServer,
  type Socket,
} from 'net'
import treeKill from 'tree-kill'
import stripAnsi from 'strip-ansi'
import type { IPty } from 'node-pty'
import {
  closeSync,
  createReadStream,
  existsSync,
  openSync,
  statSync,
} from 'fs'
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'
import { getSessionId } from '../bootstrap/state.js'
import { getInitialSettings } from './settings/settings.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from './envUtils.js'
import { isProcessRunning } from './genericProcessUtils.js'
import { safeParseJSON } from './json.js'
import { jsonStringify } from './slowOperations.js'
import { randomUUID } from './crypto.js'
import { isInBundledMode } from './bundledMode.js'
import {
  AGENT_VIEW_DETACH_SEQUENCE,
  AGENT_VIEW_PTY_ENV,
  AGENT_VIEW_SESSION_ENV,
} from './agentViewReturn.js'
import {
  getAgentViewControlSocketPath,
  type AgentViewControlMessage,
  writeAgentViewControlMessage,
} from './agentViewControl.js'
import {
  hasWorktreeChanges,
  removeAgentWorktree,
} from './worktree.js'

export type AgentViewStatus =
  | 'working'
  | 'needs_input'
  | 'idle'
  | 'ready_for_review'
  | 'completed'
  | 'failed'
  | 'stopped'

export type AgentJobState = {
  id: string
  sessionId: string
  cwd: string
  rootCwd: string
  prompt: string
  status: AgentViewStatus
  createdAt: number
  updatedAt: number
  startedAt?: number
  completedAt?: number
  model?: string
  effort?: string
  permissionMode?: string
  agent?: string
  name?: string
  args: string[]
  logPath: string
  transcriptPath?: string
  exitCode?: number | null
  pinned?: boolean
  attached?: boolean
  lastResult?: string
  lastPrompt?: string
  worktreePath?: string
  worktreeBranch?: string
  worktreeHeadCommit?: string
  worktreeGitRoot?: string
  worktreeHookBased?: boolean
  worktreeRemovedAt?: number
  daemonPid?: number
  daemonStartedAt?: number
  clientRequestId?: string
  workerPid?: number
  turnStartedAt?: number
  resumeSessionId?: string
  transport?: 'pty-v1'
  ptySocketPath?: string
  ptyToken?: string
  attachedPid?: number
  terminalCols?: number
  terminalRows?: number
}

export type AgentRoster = {
  updatedAt: number
  jobs: Record<
    string,
    {
      id: string
      sessionId: string
      workerPid?: number
      cwd: string
      status: AgentViewStatus
      updatedAt: number
    }
  >
}

export type CreateAgentJobOptions = {
  cwd?: string
  rootCwd?: string
  prompt: string
  clientRequestId?: string
  args?: string[]
  name?: string
  model?: string
  effort?: string
  permissionMode?: string
  agent?: string
  resumeSessionId?: string
}

type LaunchAgentProcessOptions = {
  id: string
  cwd: string
  sessionId: string
  args: string[]
  name: string
  agent?: string
  resumeSessionId?: string
  initialPromptPath?: string
}

type AgentPtyAttachInfo = {
  state: AgentJobState
  socketPath: string
  token: string
}

type AgentDaemonCreateOptions = Omit<CreateAgentJobOptions, 'clientRequestId'> & {
  rootCwd: string
}

type AgentDaemonRequest =
  | { method: 'ping' }
  | { method: 'list'; cwd?: string }
  | { method: 'get'; ref: string }
  | { method: 'create'; requestId: string; options: AgentDaemonCreateOptions }
  | { method: 'stop'; ref: string }
  | { method: 'remove'; ref: string; options?: RemoveAgentJobOptions }
  | { method: 'inspectRemove'; ref: string }
  | { method: 'respawn'; ref: string }
  | { method: 'respawnAll' }
  | { method: 'rename'; ref: string; name: string }
  | { method: 'reply'; ref: string; prompt: string }
  | { method: 'prepareOpen'; ref: string; cols?: number; rows?: number }
  | {
      method: 'finishOpen'
      ref: string
      code: number | null
      returnedToAgentView: boolean
    }
  | { method: 'pin'; ref: string }
  | { method: 'logs'; ref: string; bytes?: number; raw?: boolean }

export type RemoveAgentJobOptions = {
  discardWorktreeChanges?: boolean
}

export type RemoveAgentJobDryRun = {
  state: AgentJobState
  wouldRemoveWorktree: boolean
  hasWorktreeChanges: boolean
  worktreePath?: string
}

export type AgentDispatchDefaults = {
  args: string[]
  cwd: string
  rootCwd: string
  model?: string
  effort?: string
  permissionMode?: string
  agent?: string
  name?: string
}

export type AgentViewGroupMode = 'state' | 'directory'

export type ListAgentJobsOptions = {
  cwd?: string
}

export type AgentViewFilter = {
  agent?: string
  status?: AgentViewStatus
  pr?: string
  text?: string
}

const AGENT_VIEW_DAEMON_ARG = '--agent-view-daemon'
const AGENT_VIEW_DAEMON_PROTOCOL_VERSION = 3
const AGENT_VIEW_DAEMON_PING_TIMEOUT_MS = 5000
const AGENT_VIEW_DAEMON_IDLE_EXIT_MS = 5 * 60 * 1000
const AGENT_VIEW_WORKER_IDLE_MS = 60 * 60 * 1000
const AGENT_VIEW_RPC_MAX_BYTES = 16 * 1024 * 1024
const AGENT_VIEW_LOG_TAIL_BYTES = 1024 * 1024
const AGENT_VIEW_DEFAULT_COLS = 120
const AGENT_VIEW_DEFAULT_ROWS = 30
const AGENT_VIEW_PTY_FRAME_MAX_BYTES = 16 * 1024 * 1024
const AGENT_VIEW_INITIAL_PROMPT_ACK_TIMEOUT_MS = 15_000
const AGENT_VIEW_ATTACH_TIMEOUT_MS = 5_000
const AGENT_VIEW_DAEMON_BUILD_HASH = [
  AGENT_VIEW_DAEMON_PROTOCOL_VERSION,
  MACRO.VERSION,
  MACRO.BUILD_TIME || 'dev',
  getAgentViewEntrypointStamp(),
].join(':')

type AgentPtyFrame =
  | { type: 'hello'; token: string; pid?: number }
  | { type: 'attached' }
  | { type: 'input'; data: string }
  | { type: 'input_state'; text: string; cursor: number }
  | { type: 'submit_prompt'; text: string }
  | { type: 'output'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'detach' }
  | { type: 'exit'; code: number | null }
  | { type: 'error'; message: string }

let agentViewDaemonRuntime = false

type AgentDaemonEndpoint = {
  pid: number
  port: number
  token: string
  startedAt: number
  protocolVersion: number
  buildVersion: string
  buildHash: string
}

type AgentDaemonRpcResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: string }

type ManagedAgentWorker = {
  pty: IPty
  socketServer: NetServer
  socketPath: string
  token: string
  attachedSocket?: Socket
  exited: boolean
  stopReason?: 'stop' | 'idle'
  controlQueue?: Promise<void>
  controlSocket?: Socket
  controlSocketConnecting?: Promise<Socket>
  outputControlBuffer?: string
}

const daemonWorkers = new Map<string, ManagedAgentWorker>()
const pendingCreateRequests = new Map<string, Promise<AgentJobState>>()
let lastDaemonClientAt = now()
let nodePtyModule: typeof import('node-pty') | undefined

async function loadNodePty(): Promise<typeof import('node-pty')> {
  nodePtyModule ??= await import('node-pty')
  return nodePtyModule
}

function getAgentViewEntrypointStamp(): string {
  const entrypoint = process.argv[1]
  if (!entrypoint) return 'no-entrypoint'
  try {
    return String(Math.trunc(statSync(entrypoint).mtimeMs))
  } catch {
    return 'unknown-entrypoint'
  }
}

function getAgentDaemonBuildHash(): string {
  return AGENT_VIEW_DAEMON_BUILD_HASH
}

export function getAgentJobsDir(): string {
  return join(getClaudeConfigHomeDir(), 'jobs')
}

export function getAgentJobDir(id: string): string {
  return join(getAgentJobsDir(), id)
}

export function getAgentJobStatePath(id: string): string {
  return join(getAgentJobDir(id), 'state.json')
}

function getAgentJobInitialPromptPath(id: string): string {
  return join(getAgentJobDir(id), 'initial-prompt.json')
}

function getAgentJobDaemonLogPath(id: string): string {
  return join(getAgentJobDir(id), 'daemon.log')
}

export function getAgentDaemonDir(): string {
  return join(getClaudeConfigHomeDir(), 'daemon')
}

export function getAgentRosterPath(): string {
  return join(getAgentDaemonDir(), 'roster.json')
}

function getAgentDaemonEndpointPath(): string {
  return join(getAgentDaemonDir(), 'endpoint.json')
}

export function getAgentDaemonLogPath(): string {
  return join(getClaudeConfigHomeDir(), 'daemon.log')
}

export function isAgentViewDisabled(): boolean {
  return (
    isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_AGENT_VIEW) ||
    getInitialSettings().disableAgentView === true
  )
}

export function assertAgentViewEnabled(): void {
  if (isAgentViewDisabled()) {
    throw new Error(
      'Agent view is disabled by disableAgentView or CLAUDE_CODE_DISABLE_AGENT_VIEW.',
    )
  }
}

function isAgentJobProcessRunning(state: AgentJobState): boolean {
  const worker = daemonWorkers.get(state.id)
  return Boolean(
    (worker?.pty.pid && isProcessRunning(worker.pty.pid)) ||
      (state.workerPid && isProcessRunning(state.workerPid)),
  )
}

function getAgentJobProcessPid(state: AgentJobState): number | undefined {
  const daemonWorker = daemonWorkers.get(state.id)
  if (
    daemonWorker?.pty.pid &&
    isProcessRunning(daemonWorker.pty.pid)
  ) {
    return daemonWorker.pty.pid
  }
  if (state.workerPid && isProcessRunning(state.workerPid)) {
    return state.workerPid
  }
  return undefined
}

function now(): number {
  return Date.now()
}

function normalizePath(path: string): string {
  return resolve(path).normalize('NFC')
}

async function pathIsDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

function pathIsDirectorySync(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function isPathInsideOrEqual(path: string, parent: string): boolean {
  const rel = relative(normalizePath(parent), normalizePath(path))
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel))
}

function parseAgentState(value: unknown): AgentJobState | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<AgentJobState>
  if (
    typeof raw.id !== 'string' ||
    typeof raw.sessionId !== 'string' ||
    typeof raw.cwd !== 'string' ||
    typeof raw.rootCwd !== 'string' ||
    typeof raw.prompt !== 'string' ||
    typeof raw.status !== 'string' ||
    typeof raw.createdAt !== 'number' ||
    typeof raw.updatedAt !== 'number' ||
    typeof raw.logPath !== 'string' ||
    !Array.isArray(raw.args)
  ) {
    return null
  }
  return {
    ...raw,
    id: raw.id,
    sessionId: raw.sessionId,
    workerPid: raw.workerPid,
    daemonPid: raw.daemonPid,
    cwd: raw.cwd,
    rootCwd: raw.rootCwd,
    prompt: raw.prompt,
    status: raw.status as AgentViewStatus,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    args: raw.args.filter((arg): arg is string => typeof arg === 'string'),
    logPath: raw.logPath,
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, `${jsonStringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
}

async function appendDaemonLog(message: string): Promise<void> {
  const line = `${new Date().toISOString()} ${message}\n`
  await mkdir(dirname(getAgentDaemonLogPath()), { recursive: true, mode: 0o700 })
  await writeFile(getAgentDaemonLogPath(), line, {
    encoding: 'utf8',
    flag: 'a',
    mode: 0o600,
  })
}

async function appendAgentWorkerLog(id: string, message: string): Promise<void> {
  const line = `${new Date().toISOString()} ${message}\n`
  await mkdir(getAgentJobDir(id), { recursive: true, mode: 0o700 })
  await appendFile(getAgentJobDaemonLogPath(id), line, {
    encoding: 'utf8',
    mode: 0o600,
  })
}

async function readAgentState(id: string): Promise<AgentJobState | null> {
  try {
    const raw = await readFile(getAgentJobStatePath(id), 'utf8')
    return parseAgentState(safeParseJSON(raw, false))
  } catch {
    return null
  }
}

async function writeAgentState(state: AgentJobState): Promise<void> {
  await writeJsonFile(getAgentJobStatePath(state.id), state)
}

async function writeAgentInitialPromptFile(
  state: AgentJobState,
  prompt: string,
): Promise<string> {
  const path = getAgentJobInitialPromptPath(state.id)
  await writeJsonFile(path, {
    jobId: state.id,
    sessionId: state.sessionId,
    prompt,
    createdAt: now(),
  })
  return path
}

async function updateAgentState(
  id: string,
  patch: Partial<AgentJobState>,
): Promise<AgentJobState | null> {
  const state = await readAgentState(id)
  if (!state) return null
  const updated = { ...state, ...patch, updatedAt: now() }
  await writeAgentState(updated)
  await writeRosterFromStates()
  return updated
}

async function patchAgentState(
  id: string,
  patch: Partial<AgentJobState>,
): Promise<void> {
  await updateAgentState(id, patch)
}

async function readAllAgentStates(): Promise<AgentJobState[]> {
  let entries: string[]
  try {
    entries = await readdir(getAgentJobsDir())
  } catch {
    return []
  }
  const states = await Promise.all(entries.map(entry => readAgentState(entry)))
  return states.filter((state): state is AgentJobState => state !== null)
}

async function findAgentStateByClientRequestId(
  clientRequestId: string | undefined,
): Promise<AgentJobState | null> {
  if (!clientRequestId) return null
  const states = await readAllAgentStates()
  return (
    states
      .filter(state => state.clientRequestId === clientRequestId)
      .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
  )
}

async function waitForAgentTurnStart(
  id: string,
  worker: ManagedAgentWorker,
): Promise<boolean> {
  const deadline = now() + AGENT_VIEW_INITIAL_PROMPT_ACK_TIMEOUT_MS
  while (now() < deadline) {
    const state = await readAgentState(id)
    if (state?.turnStartedAt) return true
    if (worker.exited || (worker.pty.pid && !isProcessRunning(worker.pty.pid))) {
      return false
    }
    await sleep(100)
  }
  return false
}

async function monitorAgentInitialPromptStart(
  id: string,
  worker: ManagedAgentWorker,
): Promise<void> {
  const acknowledged = await waitForAgentTurnStart(id, worker)
  if (acknowledged) {
    await appendAgentWorkerLog(id, 'initial-prompt-acknowledged')
    return
  }
  await appendAgentWorkerLog(id, 'initial-prompt-ack-timeout')
  const state = await readAgentState(id)
  if (!state || state.turnStartedAt || state.status !== 'working') return
  await updateAgentState(id, {
    status: 'failed',
    completedAt: now(),
    exitCode: 1,
    lastResult:
      'Agent View initial prompt was not accepted by the background session before timeout.',
  })
}

export async function writeRosterFromStates(): Promise<void> {
  const states = await readAllAgentStates()
  const jobs: AgentRoster['jobs'] = {}
  for (const state of states) {
    if (state.status !== 'working' && state.status !== 'needs_input') continue
    jobs[state.id] = {
      id: state.id,
      sessionId: state.sessionId,
      workerPid: state.workerPid,
      cwd: state.cwd,
      status: state.status,
      updatedAt: state.updatedAt,
    }
  }
  await writeJsonFile(getAgentRosterPath(), {
    updatedAt: now(),
    jobs,
  } satisfies AgentRoster)
}

export function getAgentViewExecutableInvocation(): { command: string; prefixArgs: string[] } {
  if (isInBundledMode()) {
    return { command: process.execPath, prefixArgs: [] }
  }
  const entrypoint = process.argv[1]
  if (entrypoint) {
    return { command: process.execPath, prefixArgs: [entrypoint] }
  }
  return { command: process.execPath, prefixArgs: [] }
}

function parseAgentDaemonEndpoint(value: unknown): AgentDaemonEndpoint | null {
  const parsed = value as Partial<AgentDaemonEndpoint> | null
  if (
    !parsed ||
    typeof parsed.pid !== 'number' ||
    typeof parsed.port !== 'number' ||
    typeof parsed.token !== 'string' ||
    typeof parsed.startedAt !== 'number' ||
    parsed.protocolVersion !== AGENT_VIEW_DAEMON_PROTOCOL_VERSION ||
    parsed.buildVersion !== MACRO.VERSION ||
    parsed.buildHash !== getAgentDaemonBuildHash()
  ) {
    return null
  }
  return {
    pid: parsed.pid,
    port: parsed.port,
    token: parsed.token,
    startedAt: parsed.startedAt,
    protocolVersion: parsed.protocolVersion,
    buildVersion: parsed.buildVersion,
    buildHash: parsed.buildHash,
  }
}

async function readStoredAgentDaemonEndpoint(): Promise<Partial<AgentDaemonEndpoint> | null> {
  try {
    const raw = await readFile(getAgentDaemonEndpointPath(), 'utf8')
    return safeParseJSON(raw, false) as Partial<AgentDaemonEndpoint> | null
  } catch {
    return null
  }
}

async function readAgentDaemonEndpoint(): Promise<AgentDaemonEndpoint | null> {
  return parseAgentDaemonEndpoint(await readStoredAgentDaemonEndpoint())
}

async function writeAgentDaemonEndpoint(endpoint: AgentDaemonEndpoint): Promise<void> {
  await writeJsonFile(getAgentDaemonEndpointPath(), endpoint)
}

async function removeAgentDaemonEndpoint(): Promise<void> {
  await rm(getAgentDaemonEndpointPath(), { force: true })
}

function sameAgentDaemonEndpoint(
  a: AgentDaemonEndpoint | null,
  b: AgentDaemonEndpoint,
): boolean {
  return Boolean(
    a &&
      a.pid === b.pid &&
      a.port === b.port &&
      a.token === b.token &&
      a.startedAt === b.startedAt &&
      a.protocolVersion === b.protocolVersion &&
      a.buildVersion === b.buildVersion &&
      a.buildHash === b.buildHash,
  )
}

async function removeAgentDaemonEndpointIfCurrent(
  endpoint: AgentDaemonEndpoint,
): Promise<void> {
  if (sameAgentDaemonEndpoint(await readAgentDaemonEndpoint(), endpoint)) {
    await removeAgentDaemonEndpoint()
  }
}

function isRetryableAgentDaemonError(error: unknown): boolean {
  const maybeNodeError = error as { code?: unknown; message?: unknown }
  const code = typeof maybeNodeError.code === 'string' ? maybeNodeError.code : ''
  if (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    code === 'ETIMEDOUT' ||
    code === 'ERR_SOCKET_CLOSED'
  ) {
    return true
  }

  const message =
    typeof maybeNodeError.message === 'string' ? maybeNodeError.message : ''
  return (
    message.includes('socket hang up') ||
    message.includes('Socket is closed') ||
    message.includes('Agent View daemon timed out.')
  )
}

function isSocketClosedError(error: unknown): boolean {
  const maybeNodeError = error as { code?: unknown; message?: unknown }
  const code = typeof maybeNodeError.code === 'string' ? maybeNodeError.code : ''
  if (code === 'ERR_SOCKET_CLOSED' || code === 'ECONNRESET' || code === 'EPIPE') {
    return true
  }
  const message =
    typeof maybeNodeError.message === 'string' ? maybeNodeError.message : ''
  return (
    message.includes('Socket is closed') ||
    message.includes('socket hang up') ||
    message.includes('write EPIPE')
  )
}

function installAgentViewDaemonExceptionHandlers(): () => void {
  const crash = (error: unknown): never => {
    process.off('uncaughtException', onUncaughtException)
    process.off('unhandledRejection', onUnhandledRejection)
    if (error instanceof Error) throw error
    throw new Error(String(error))
  }

  const onUncaughtException = (error: Error) => {
    if (!isSocketClosedError(error)) crash(error)
    void appendDaemonLog(`daemon-socket-closed ${formatAgentViewError(error)}`)
  }
  const onUnhandledRejection = (reason: unknown) => {
    if (!isSocketClosedError(reason)) crash(reason)
    void appendDaemonLog(`daemon-socket-rejection ${formatAgentViewError(reason)}`)
  }

  process.on('uncaughtException', onUncaughtException)
  process.on('unhandledRejection', onUnhandledRejection)
  return () => {
    process.off('uncaughtException', onUncaughtException)
    process.off('unhandledRejection', onUnhandledRejection)
  }
}

function agentDaemonRequestCanRetry(payload: AgentDaemonRequest): boolean {
  return (
    payload.method === 'list' ||
    payload.method === 'get' ||
    payload.method === 'logs' ||
    payload.method === 'create'
  )
}

function httpRequestJson(
  endpoint: AgentDaemonEndpoint,
  payload: AgentDaemonRequest,
  timeoutMs = AGENT_VIEW_DAEMON_PING_TIMEOUT_MS,
): Promise<AgentDaemonRpcResponse> {
  const body = jsonStringify(payload)
  return new Promise((resolvePromise, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: endpoint.port,
        method: 'POST',
        path: '/rpc',
        timeout: timeoutMs,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          authorization: `Bearer ${endpoint.token}`,
        },
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', chunk => {
          size += Buffer.byteLength(chunk)
          if (size > AGENT_VIEW_RPC_MAX_BYTES) {
            req.destroy(new Error('Agent View daemon response is too large.'))
            return
          }
          chunks.push(Buffer.from(chunk))
        })
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          const parsed = safeParseJSON(text, false) as AgentDaemonRpcResponse | null
          if (!parsed || typeof parsed.ok !== 'boolean') {
            reject(new Error('Agent View daemon returned an invalid response.'))
            return
          }
          resolvePromise(parsed)
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error('Agent View daemon timed out.')))
    req.on('error', reject)
    req.end(body)
  })
}

async function callAgentDaemon(
  requestPayload: AgentDaemonRequest,
): Promise<unknown> {
  const endpoint = await ensureAgentViewDaemon()
  let response: AgentDaemonRpcResponse
  try {
    response = await httpRequestJson(endpoint, requestPayload)
  } catch (error) {
    if (
      !isRetryableAgentDaemonError(error) ||
      !agentDaemonRequestCanRetry(requestPayload)
    ) {
      throw error
    }
    const aliveEndpoint = await pingAgentDaemon(endpoint)
    if (aliveEndpoint) {
      response = await httpRequestJson(aliveEndpoint, requestPayload)
    } else {
      await removeAgentDaemonEndpointIfCurrent(endpoint)
      const retryEndpoint = await ensureAgentViewDaemon()
      response = await httpRequestJson(retryEndpoint, requestPayload)
    }
  }
  if (!response.ok) {
    throw new Error((response as { ok: false; error: string }).error)
  }
  return response.result
}

function liveDaemonWorkerFor(state: AgentJobState): ManagedAgentWorker | null {
  const worker = daemonWorkers.get(state.id)
  if (!worker || worker.exited || !isProcessRunning(worker.pty.pid)) return null
  return worker
}

async function pingAgentDaemon(
  endpoint: AgentDaemonEndpoint | null,
): Promise<AgentDaemonEndpoint | null> {
  if (!endpoint) return null
  if (!isProcessRunning(endpoint.pid)) return null
  try {
    const response = await httpRequestJson(endpoint, { method: 'ping' })
    if (!response.ok) return null
    return parseAgentDaemonEndpoint(response.result)
  } catch {
    return null
  }
}

async function waitForAgentDaemon(
  endpoint: AgentDaemonEndpoint | null,
): Promise<AgentDaemonEndpoint | null> {
  const deadline = Date.now() + AGENT_VIEW_DAEMON_PING_TIMEOUT_MS
  let current = endpoint
  while (Date.now() < deadline) {
    const alive = await pingAgentDaemon(current ?? (await readAgentDaemonEndpoint()))
    if (alive) return alive
    current = await readAgentDaemonEndpoint()
    await sleep(100)
  }
  return null
}

async function ensureAgentViewDaemon(): Promise<AgentDaemonEndpoint> {
  const storedEndpoint = await readStoredAgentDaemonEndpoint()
  const existing = await pingAgentDaemon(parseAgentDaemonEndpoint(storedEndpoint))
  if (existing) return existing

  if (
    storedEndpoint?.pid &&
    typeof storedEndpoint.pid === 'number' &&
    storedEndpoint.pid !== process.pid &&
    isProcessRunning(storedEndpoint.pid)
  ) {
    await appendDaemonLog(
      `daemon-retire pid=${storedEndpoint.pid} protocol=${String(storedEndpoint.protocolVersion ?? 'missing')} build=${String(storedEndpoint.buildHash ?? 'missing')}`,
    )
    await killProcessTree(storedEndpoint.pid)
  }
  await removeAgentDaemonEndpoint()
  await mkdir(getAgentDaemonDir(), { recursive: true, mode: 0o700 })
  const { command, prefixArgs } = getAgentViewExecutableInvocation()
  const logFd = openSync(getAgentDaemonLogPath(), 'a')
  try {
    const child = spawn(command, [...prefixArgs, AGENT_VIEW_DAEMON_ARG], {
      cwd: process.cwd(),
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: process.env,
      windowsHide: true,
    })
    await appendDaemonLog(
      `daemon-spawn pid=${child.pid ?? 'unknown'}`,
    )
    child.unref()
  } finally {
    closeSync(logFd)
  }

  const endpoint = await waitForAgentDaemon(null)
  if (!endpoint) {
    throw new Error('Agent View daemon did not start.')
  }
  return endpoint
}

const SINGULAR_VALUE_OPTIONS = new Set([
  '--model',
  '--effort',
  '--permission-mode',
  '--settings',
  '--plugin-dir',
  '--plugin-url',
  '--agent',
  '--name',
  '-n',
  '--agents',
  '--fallback-model',
  '--system-prompt',
  '--system-prompt-file',
  '--append-system-prompt',
  '--append-system-prompt-file',
  '--permission-prompt-tool',
  '--max-turns',
  '--max-budget-usd',
  '--task-budget',
  '--json-schema',
  '--input-format',
  '--output-format',
  '--session-id',
  '--agent-view-initial-prompt-file',
  '--resume',
  '-r',
  '--cwd',
  '--debug-file',
  '--workload',
  '--advisor',
])

const OPTIONAL_VALUE_OPTIONS = new Set([
  '--worktree',
  '-w',
  '--from-pr',
])

const VARIADIC_VALUE_OPTIONS = new Set([
  '--add-dir',
  '--mcp-config',
  '--allowedTools',
  '--allowed-tools',
  '--tools',
  '--disallowedTools',
  '--disallowed-tools',
  '--betas',
  '--file',
])

const BOOLEAN_OPTIONS = new Set([
  '-p',
  '--print',
  '--bg',
  '--background',
  '--bare',
  '--verbose',
  '--debug',
  '--debug-to-stderr',
  '--include-hook-events',
  '--include-partial-messages',
  '--mcp-debug',
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--strict-mcp-config',
  '--continue',
  '-c',
  '--fork-session',
  '--no-session-persistence',
  '--disable-slash-commands',
  '--strict-mcp-config',
  '--tmux',
  '--json',
])

function optionName(arg: string): string {
  const eq = arg.indexOf('=')
  return eq === -1 ? arg : arg.slice(0, eq)
}

export function extractPromptFromArgs(args: string[]): string {
  const promptParts: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    const name = optionName(arg)
    if (BOOLEAN_OPTIONS.has(name)) continue
    if (SINGULAR_VALUE_OPTIONS.has(name)) {
      if (!arg.includes('=')) i++
      continue
    }
    if (OPTIONAL_VALUE_OPTIONS.has(name)) {
      if (!arg.includes('=') && args[i + 1] && !args[i + 1]!.startsWith('-')) {
        i++
      }
      continue
    }
    if (VARIADIC_VALUE_OPTIONS.has(name)) {
      while (args[i + 1] && !args[i + 1]!.startsWith('-')) i++
      continue
    }
    if (arg.startsWith('-')) continue
    promptParts.push(arg)
  }
  return promptParts.join(' ').trim()
}

export function readOptionValue(
  args: string[],
  option: string,
): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === option) return args[i + 1]
    if (arg.startsWith(`${option}=`)) return arg.slice(option.length + 1)
  }
  return undefined
}

export function getAgentDispatchDefaults(args: string[]): AgentDispatchDefaults {
  const normalizedCwd = normalizePath(process.cwd())
  return {
    args,
    cwd: normalizedCwd,
    rootCwd: normalizedCwd,
    model: readOptionValue(args, '--model'),
    effort: readOptionValue(args, '--effort'),
    permissionMode: readOptionValue(args, '--permission-mode'),
    agent: readOptionValue(args, '--agent'),
    name: readOptionValue(args, '--name'),
  }
}

function stripManagedLaunchOptions(args: string[]): string[] {
  const stripped: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    const name = optionName(arg)
    if (
      name === '--bg' ||
      name === '--background' ||
      name === '-p' ||
      name === '--print' ||
      name === '--output-format' ||
      name === '--session-id' ||
      name === '--resume' ||
      name === '-r' ||
      name === '--cwd' ||
      name === '--worktree' ||
      name === '-w' ||
      name === '--tmux'
    ) {
      if (
        !arg.includes('=') &&
        (name === '--output-format' ||
          name === '--session-id' ||
          name === '--resume' ||
          name === '-r' ||
          name === '--cwd' ||
          name === '--worktree' ||
          name === '-w')
      ) {
        i++
      }
      continue
    }
    stripped.push(arg)
  }
  return stripped
}

function stripPromptPositionals(args: string[]): string[] {
  const stripped: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    const name = optionName(arg)
    if (BOOLEAN_OPTIONS.has(name)) {
      stripped.push(arg)
      continue
    }
    if (SINGULAR_VALUE_OPTIONS.has(name)) {
      stripped.push(arg)
      if (!arg.includes('=') && i + 1 < args.length) {
        stripped.push(args[i + 1]!)
        i++
      }
      continue
    }
    if (OPTIONAL_VALUE_OPTIONS.has(name)) {
      stripped.push(arg)
      if (!arg.includes('=') && args[i + 1] && !args[i + 1]!.startsWith('-')) {
        stripped.push(args[i + 1]!)
        i++
      }
      continue
    }
    if (VARIADIC_VALUE_OPTIONS.has(name)) {
      stripped.push(arg)
      while (args[i + 1] && !args[i + 1]!.startsWith('-')) {
        stripped.push(args[i + 1]!)
        i++
      }
      continue
    }
    if (arg.startsWith('-')) {
      stripped.push(arg)
      continue
    }
  }
  return stripped
}

function inferDisplayName(prompt: string, explicitName: string | undefined): string {
  if (explicitName?.trim()) return explicitName.trim()
  const firstLine = prompt.replace(/\s+/g, ' ').trim()
  if (firstLine.length <= 48) return firstLine
  return `${firstLine.slice(0, 45)}...`
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

function killProcessTree(pid: number, signal: string = 'SIGTERM'): Promise<void> {
  return new Promise(resolvePromise => {
    treeKill(pid, signal, () => resolvePromise())
  })
}

function getExistingCwd(primary: string, fallback: string): string {
  return pathIsDirectorySync(primary) ? primary : fallback
}

async function createUniqueJobId(): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const id = randomUUID().split('-')[0]!
    if (!existsSync(getAgentJobDir(id))) return id
  }
  return randomUUID()
}

function encodeFrame(frame: AgentPtyFrame): Buffer {
  const payload = Buffer.from(jsonStringify(frame), 'utf8')
  const header = Buffer.allocUnsafe(4)
  header.writeUInt32BE(payload.length, 0)
  return Buffer.concat([header, payload])
}

function socketIsWritable(socket: Socket): boolean {
  const maybeClosedSocket = socket as Socket & { closed?: boolean }
  return (
    !socket.destroyed &&
    !maybeClosedSocket.closed &&
    socket.writable &&
    !socket.writableEnded
  )
}

function writeFrame(socket: Socket, frame: AgentPtyFrame): boolean {
  if (!socketIsWritable(socket)) return false
  try {
    socket.write(encodeFrame(frame))
    return true
  } catch {
    return false
  }
}

function endSocket(socket: Socket | undefined): void {
  if (!socket || socket.destroyed) return
  try {
    socket.end()
  } catch {
    socket.destroy()
  }
}

function formatAgentViewError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function clearAttachedSocket(
  state: AgentJobState,
  worker: ManagedAgentWorker,
  socket: Socket | undefined,
): void {
  if (!socket || worker.attachedSocket !== socket) return
  worker.attachedSocket = undefined
  void updateAgentState(state.id, {
    attached: false,
    attachedPid: undefined,
  })
}

function onFrames(socket: Socket, onFrame: (frame: AgentPtyFrame) => void): void {
  let buffer = Buffer.alloc(0)
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)])
    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(0)
      if (length > AGENT_VIEW_PTY_FRAME_MAX_BYTES) {
        socket.destroy(new Error('Agent View PTY frame is too large.'))
        return
      }
      if (buffer.length < 4 + length) return
      const payload = buffer.subarray(4, 4 + length).toString('utf8')
      buffer = buffer.subarray(4 + length)
      const parsed = safeParseJSON(payload, false) as AgentPtyFrame | null
      if (parsed?.type) onFrame(parsed)
    }
  })
}

function encodePtyData(data: string | Buffer): string {
  return Buffer.from(data).toString('base64')
}

function decodePtyData(data: string): Buffer {
  return Buffer.from(data, 'base64')
}

function getAgentPtySocketPath(id: string): string {
  const suffix = `${process.pid}-${id}-${randomUUID().slice(0, 8)}`
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\microclaude-agent-${suffix}`
  }
  return join(getAgentDaemonDir(), `pty-${suffix}.sock`)
}

function buildPtyLaunchArgs(options: LaunchAgentProcessOptions): string[] {
  return [
    ...options.args,
    ...(options.resumeSessionId
      ? ['--resume', options.resumeSessionId]
      : ['--session-id', options.sessionId]),
    ...(options.initialPromptPath
      ? ['--agent-view-initial-prompt-file', options.initialPromptPath]
      : []),
  ]
}

function appendPtyLog(id: string, logPath: string, data: string): void {
  void appendFile(logPath, data, {
    encoding: 'utf8',
    mode: 0o600,
  }).catch(error =>
    appendAgentWorkerLog(id, `log-error ${error instanceof Error ? error.message : String(error)}`),
  )
}

function trailingAgentViewDetachPrefixLength(text: string): number {
  const maxLength = Math.min(text.length, AGENT_VIEW_DETACH_SEQUENCE.length - 1)
  for (let length = maxLength; length > 0; length--) {
    if (text.endsWith(AGENT_VIEW_DETACH_SEQUENCE.slice(0, length))) {
      return length
    }
  }
  return 0
}

function consumeAgentViewDetachSequences(
  worker: ManagedAgentWorker,
  data: string,
): { output: string; detachRequested: boolean } {
  let remaining = `${worker.outputControlBuffer ?? ''}${data}`
  worker.outputControlBuffer = undefined

  let output = ''
  let detachRequested = false
  while (true) {
    const index = remaining.indexOf(AGENT_VIEW_DETACH_SEQUENCE)
    if (index === -1) break
    output += remaining.slice(0, index)
    remaining = remaining.slice(index + AGENT_VIEW_DETACH_SEQUENCE.length)
    detachRequested = true
  }

  const carryLength = trailingAgentViewDetachPrefixLength(remaining)
  if (carryLength > 0) {
    output += remaining.slice(0, remaining.length - carryLength)
    worker.outputControlBuffer = remaining.slice(remaining.length - carryLength)
  } else {
    output += remaining
  }

  return { output, detachRequested }
}

function requestAttachedSocketDetach(
  state: AgentJobState,
  worker: ManagedAgentWorker,
): void {
  const socket = worker.attachedSocket
  if (!socket) return
  writeFrame(socket, { type: 'detach' })
  clearAttachedSocket(state, worker, socket)
  endSocket(socket)
}

function dispatchPtyOutput(
  state: AgentJobState,
  worker: ManagedAgentWorker,
  data: string,
): void {
  const { output, detachRequested } = consumeAgentViewDetachSequences(worker, data)
  if (output) appendPtyLog(state.id, state.logPath, output)
  if (output && worker.attachedSocket) {
    const socket = worker.attachedSocket
    const wrote = writeFrame(socket, {
      type: 'output',
      data: encodePtyData(output),
    })
    if (!wrote) {
      clearAttachedSocket(state, worker, socket)
      endSocket(socket)
    }
  }
  if (detachRequested) requestAttachedSocketDetach(state, worker)
}

function queueWorkerControlMessage(
  state: AgentJobState,
  worker: ManagedAgentWorker,
  message: AgentViewControlMessage,
  options: { retryMs?: number; onError?: (error: unknown) => void } = {},
): Promise<void> {
  const connectControlSocket = async (): Promise<Socket> => {
    if (worker.controlSocket && socketIsWritable(worker.controlSocket)) {
      return worker.controlSocket
    }
    if (worker.controlSocketConnecting) return await worker.controlSocketConnecting

    const socketPath = getAgentViewControlSocketPath(
      state.id,
      getAgentJobStatePath(state.id),
    )
    const deadline = now() + (options.retryMs ?? AGENT_VIEW_DAEMON_PING_TIMEOUT_MS)
    worker.controlSocketConnecting = (async () => {
      let lastError: unknown
      while (now() < deadline) {
        try {
          const socket = await new Promise<Socket>((resolvePromise, reject) => {
            const candidate = createConnection(socketPath)
            candidate.once('connect', () => resolvePromise(candidate))
            candidate.once('error', reject)
          })
          socket.on('close', () => {
            if (worker.controlSocket === socket) worker.controlSocket = undefined
          })
          socket.on('error', error => {
            void appendAgentWorkerLog(
              state.id,
              `control-socket-error ${formatAgentViewError(error)}`,
            )
            if (worker.controlSocket === socket) worker.controlSocket = undefined
            socket.destroy()
          })
          worker.controlSocket = socket
          return socket
        } catch (error) {
          lastError = error
          await sleep(100)
        }
      }
      throw lastError instanceof Error
        ? lastError
        : new Error('Agent View control socket did not become ready.')
    })()
    try {
      return await worker.controlSocketConnecting
    } finally {
      worker.controlSocketConnecting = undefined
    }
  }

  const run = async () => {
    const socket = await connectControlSocket()
    writeAgentViewControlMessage(socket, message)
  }
  const previous = worker.controlQueue ?? Promise.resolve()
  const queued = previous.then(run, run).catch(error => {
    void appendAgentWorkerLog(
      state.id,
      `control-message-error type=${message.type} ${formatAgentViewError(error)}`,
    )
    options.onError?.(error)
    throw error
  })
  worker.controlQueue = queued.catch(() => {})
  return queued
}

function writeWorkerPtyInput(
  state: AgentJobState,
  worker: ManagedAgentWorker,
  data: string | Buffer,
  socket?: Socket,
): boolean {
  try {
    worker.pty.write(typeof data === 'string' ? data : data.toString('utf8'))
    return true
  } catch (error) {
    void appendAgentWorkerLog(
      state.id,
      `pty-write-error ${formatAgentViewError(error)}`,
    )
    if (socket) {
      writeFrame(socket, {
        type: 'error',
        message: 'Background session PTY is no longer writable.',
      })
      clearAttachedSocket(state, worker, socket)
      endSocket(socket)
    }
    return false
  }
}

function resizeWorkerPty(
  state: AgentJobState,
  worker: ManagedAgentWorker,
  cols: number,
  rows: number,
  socket: Socket,
): boolean {
  try {
    worker.pty.resize(cols, rows)
    return true
  } catch (error) {
    void appendAgentWorkerLog(
      state.id,
      `pty-resize-error ${formatAgentViewError(error)}`,
    )
    writeFrame(socket, {
      type: 'error',
      message: 'Background session PTY can no longer be resized.',
    })
    clearAttachedSocket(state, worker, socket)
    endSocket(socket)
    return false
  }
}

function createWorkerSocketServer(
  state: AgentJobState,
  worker: ManagedAgentWorker,
): NetServer {
  const server = createNetServer(socket => {
    let authenticated = false
    const onSocketError = (error: Error) => {
      void appendAgentWorkerLog(
        state.id,
        `pty-socket-error ${formatAgentViewError(error)}`,
      )
      clearAttachedSocket(state, worker, socket)
      socket.destroy()
    }
    socket.on('error', onSocketError)
    onFrames(socket, frame => {
      if (!authenticated) {
        if (frame.type !== 'hello' || frame.token !== worker.token) {
          writeFrame(socket, { type: 'error', message: 'Invalid Agent View PTY token.' })
          socket.destroy()
          return
        }
        authenticated = true
        endSocket(worker.attachedSocket)
        worker.attachedSocket = socket
        writeFrame(socket, { type: 'attached' })
        void updateAgentState(state.id, {
          attached: true,
          attachedPid: frame.pid ?? process.pid,
        })
        return
      }

      if (frame.type === 'input') {
        writeWorkerPtyInput(state, worker, decodePtyData(frame.data), socket)
      } else if (frame.type === 'input_state') {
        void queueWorkerControlMessage(
          state,
          worker,
          {
            type: 'set_input',
            text: frame.text,
            cursor: frame.cursor,
          },
          { retryMs: 500 },
        )
      } else if (frame.type === 'submit_prompt') {
        void updateAgentState(state.id, {
          status: 'working',
          lastPrompt: frame.text,
          startedAt: now(),
          completedAt: undefined,
          exitCode: undefined,
          turnStartedAt: undefined,
        })
        void queueWorkerControlMessage(
          state,
          worker,
          { type: 'submit', text: frame.text },
          {
            retryMs: AGENT_VIEW_INITIAL_PROMPT_ACK_TIMEOUT_MS,
            onError: () => {
              writeFrame(socket, {
                type: 'error',
                message: 'Background session prompt could not be submitted.',
              })
            },
          },
        )
      } else if (frame.type === 'resize') {
        if (!resizeWorkerPty(state, worker, frame.cols, frame.rows, socket)) {
          return
        }
        void updateAgentState(state.id, {
          terminalCols: frame.cols,
          terminalRows: frame.rows,
        })
      } else if (frame.type === 'detach') {
        endSocket(socket)
      }
    })
    socket.on('close', () => {
      if (worker.attachedSocket === socket) {
        clearAttachedSocket(state, worker, socket)
      }
    })
  })
  return server
}

async function listenOnWorkerSocket(server: NetServer, socketPath: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.off('error', reject)
      resolvePromise()
    })
  })
}

async function finalizeWorkerExit(
  id: string,
  code: number | null,
): Promise<void> {
  await appendAgentWorkerLog(id, `pty-exit code=${code ?? 'unknown'}`)
  const worker = daemonWorkers.get(id)
  const stopReason = worker?.stopReason
  if (worker) {
    worker.exited = true
    if (worker.attachedSocket) writeFrame(worker.attachedSocket, { type: 'exit', code })
    endSocket(worker.attachedSocket)
    endSocket(worker.controlSocket)
    try {
      worker.socketServer.close()
    } catch {
      // The socket server may already be closed by stopManagedWorker.
    }
    daemonWorkers.delete(id)
  }
  const latest = await readAgentState(id)
  if (!latest) return
  const stopped = latest.status === 'stopped' || stopReason === 'stop'
  const idleCleanup = stopReason === 'idle'
  const status = stopped
    ? 'stopped'
    : idleCleanup
      ? latest.status
      : latest.status === 'completed'
        ? 'completed'
        : code === 0
          ? 'completed'
          : 'failed'
  await updateAgentState(id, {
    status,
    workerPid: undefined,
    attached: false,
    attachedPid: undefined,
    completedAt: idleCleanup ? latest.completedAt : now(),
    exitCode: stopped
      ? null
      : idleCleanup || latest.status === 'completed'
        ? latest.exitCode
        : (code ?? 1),
  })
}

async function startAgentWorker(
  state: AgentJobState,
  prompt: string,
  size: { cols?: number; rows?: number } = {},
): Promise<AgentJobState> {
  const existing = daemonWorkers.get(state.id)
  if (existing && !existing.exited && isProcessRunning(existing.pty.pid)) {
    const text = prompt.trim()
    if (text) {
      void queueWorkerControlMessage(
        state,
        existing,
        { type: 'submit', text },
        { retryMs: AGENT_VIEW_INITIAL_PROMPT_ACK_TIMEOUT_MS },
      )
    }
    return state
  }

  const initialPrompt = prompt.trim()
  const cwd = getExistingCwd(state.cwd, state.rootCwd)
  const socketPath = getAgentPtySocketPath(state.id)
  const token = randomUUID()
  const { command, prefixArgs } = getAgentViewExecutableInvocation()
  const initialPromptPath = initialPrompt
    ? await writeAgentInitialPromptFile(state, initialPrompt)
    : undefined
  const launchArgs = [
    ...prefixArgs,
    ...buildPtyLaunchArgs({
      id: state.id,
      cwd,
      sessionId: state.sessionId,
      args: state.args,
      name: state.name ?? inferDisplayName(state.prompt, undefined),
      agent: state.agent,
      resumeSessionId: state.resumeSessionId,
      initialPromptPath,
    }),
  ]
  const nodePty = await loadNodePty()
  const ptyProcess = nodePty.spawn(command, launchArgs, {
    cwd,
    cols: size.cols ?? state.terminalCols ?? AGENT_VIEW_DEFAULT_COLS,
    rows: size.rows ?? state.terminalRows ?? AGENT_VIEW_DEFAULT_ROWS,
    env: {
      ...process.env,
      CLAUDE_CODE_SESSION_KIND: 'bg',
      CLAUDE_CODE_SESSION_NAME: state.name,
      CLAUDE_CODE_SESSION_LOG: state.logPath,
      CLAUDE_CODE_AGENT_VIEW_JOB_ID: state.id,
      CLAUDE_CODE_AGENT_VIEW_STATE_PATH: getAgentJobStatePath(state.id),
      [AGENT_VIEW_SESSION_ENV]: '1',
      [AGENT_VIEW_PTY_ENV]: '1',
      ...(state.agent ? { CLAUDE_CODE_AGENT: state.agent } : {}),
    },
    useConpty: process.platform === 'win32' ? true : undefined,
  })

  const worker: ManagedAgentWorker = {
    pty: ptyProcess,
    socketServer: createNetServer(),
    socketPath,
    token,
    exited: false,
  }
  worker.socketServer = createWorkerSocketServer(state, worker)
  daemonWorkers.set(state.id, worker)
  await listenOnWorkerSocket(worker.socketServer, socketPath)

  ptyProcess.onData(data => dispatchPtyOutput(state, worker, data))
  ptyProcess.onExit(({ exitCode }) => {
    void finalizeWorkerExit(state.id, exitCode)
  })

  const updated = await updateAgentState(state.id, {
    transport: 'pty-v1',
    workerPid: ptyProcess.pid,
    daemonPid: process.pid,
    daemonStartedAt: now(),
    status: prompt.trim() ? 'working' : state.status,
    startedAt: now(),
    turnStartedAt: prompt.trim() ? undefined : state.turnStartedAt,
    ptySocketPath: socketPath,
    ptyToken: token,
    terminalCols: size.cols ?? state.terminalCols ?? AGENT_VIEW_DEFAULT_COLS,
    terminalRows: size.rows ?? state.terminalRows ?? AGENT_VIEW_DEFAULT_ROWS,
  })
  await appendAgentWorkerLog(
    state.id,
    `pty-start pid=${ptyProcess.pid} socket=${socketPath}`,
  )
  if (initialPrompt) {
    void monitorAgentInitialPromptStart(state.id, worker).catch(error =>
      appendAgentWorkerLog(
        state.id,
        `initial-prompt-monitor-error ${formatAgentViewError(error)}`,
      ),
    )
  }
  return updated ?? state
}

async function stopManagedWorker(
  state: AgentJobState,
  reason: 'stop' | 'idle' = 'stop',
): Promise<void> {
  const worker = daemonWorkers.get(state.id)
  if (worker) {
    worker.stopReason = reason
    endSocket(worker.attachedSocket)
    endSocket(worker.controlSocket)
    try {
      worker.socketServer.close()
    } catch {
      // The socket server may already be closing.
    }
    try {
      worker.pty.kill()
    } catch {
      // The PTY may already have exited.
    }
    await appendAgentWorkerLog(state.id, `pty-stop reason=${reason}`)
    return
  }
  const pid = getAgentJobProcessPid(state)
  if (pid) await killProcessTree(pid)
  await appendAgentWorkerLog(state.id, `pty-stop reason=${reason}`)
}

async function reapIdleAgentWorkers(): Promise<void> {
  const states = await readAllAgentStates()
  const threshold = now() - AGENT_VIEW_WORKER_IDLE_MS
  for (const state of states) {
    if (state.attached) continue
    if (state.status !== 'idle' && state.status !== 'completed') continue
    if (state.updatedAt > threshold) continue
    if (!daemonWorkers.has(state.id)) continue
    await stopManagedWorker(state, 'idle')
    await updateAgentState(state.id, {
      workerPid: undefined,
      status: state.status,
    })
  }
}

async function handleAgentDaemonRequest(
  payload: AgentDaemonRequest,
  endpoint: AgentDaemonEndpoint,
): Promise<unknown> {
  lastDaemonClientAt = now()
  switch (payload.method) {
    case 'ping':
      return endpoint
    case 'list':
      return await listAgentJobs({ cwd: payload.cwd })
    case 'get':
      return await getAgentJob(payload.ref)
    case 'create':
      return await createAgentJob({
        ...payload.options,
        clientRequestId: payload.requestId,
      })
    case 'stop':
      return await stopAgentJob(payload.ref)
    case 'remove':
      return await removeAgentJob(payload.ref, payload.options ?? {})
    case 'inspectRemove':
      return await inspectRemoveAgentJob(payload.ref)
    case 'respawn':
      return await respawnAgentJob(payload.ref)
    case 'respawnAll':
      return await respawnAllStoppedAgentJobs()
    case 'rename':
      return await updateAgentJobName(payload.ref, payload.name)
    case 'reply':
      return await replyAgentJob(payload.ref, payload.prompt)
    case 'prepareOpen':
      return await prepareAgentJobSession(payload.ref, {
        cols: payload.cols,
        rows: payload.rows,
      })
    case 'finishOpen':
      return await finishAgentJobSession(payload.ref, {
        code: payload.code,
        returnedToAgentView: payload.returnedToAgentView,
      })
    case 'pin':
      return await toggleAgentJobPinned(payload.ref)
    case 'logs':
      return payload.raw
        ? await readAgentLogRaw(payload.ref, { bytes: payload.bytes })
        : await readAgentLog(payload.ref, { bytes: payload.bytes })
  }
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const resolveOnce = (value: string) => {
      if (settled) return
      settled = true
      resolvePromise(value)
    }
    const rejectOnce = (error: Error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    req.on('data', chunk => {
      size += Buffer.byteLength(chunk)
      if (size > AGENT_VIEW_RPC_MAX_BYTES) {
        rejectOnce(new Error('Agent View daemon request is too large.'))
        req.destroy()
        return
      }
      chunks.push(Buffer.from(chunk))
    })
    req.on('aborted', () =>
      rejectOnce(new Error('Agent View daemon request was aborted.')),
    )
    req.on('error', error => rejectOnce(error))
    req.on('close', () => {
      if (!req.complete) {
        rejectOnce(new Error('Agent View daemon request closed before completion.'))
      }
    })
    req.on('end', () => resolveOnce(Buffer.concat(chunks).toString('utf8')))
  })
}

function responseIsWritable(res: ServerResponse): boolean {
  return !res.destroyed && !res.writableEnded
}

function writeEmptyRpcResponse(res: ServerResponse, statusCode: number): boolean {
  if (!responseIsWritable(res)) return false
  try {
    res.writeHead(statusCode)
    res.end()
    return true
  } catch {
    return false
  }
}

function writeRpcResponse(
  res: ServerResponse,
  response: AgentDaemonRpcResponse,
): boolean {
  if (!responseIsWritable(res)) return false
  const body = jsonStringify(response)
  try {
    res.writeHead(response.ok ? 200 : 500, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
    return true
  } catch {
    return false
  }
}

export async function runAgentViewDaemon(): Promise<void> {
  assertAgentViewEnabled()
  agentViewDaemonRuntime = true
  const uninstallExceptionHandlers = installAgentViewDaemonExceptionHandlers()
  await mkdir(getAgentDaemonDir(), { recursive: true, mode: 0o700 })
  const endpoint: AgentDaemonEndpoint = {
    pid: process.pid,
    port: 0,
    token: randomUUID(),
    startedAt: now(),
    protocolVersion: AGENT_VIEW_DAEMON_PROTOCOL_VERSION,
    buildVersion: MACRO.VERSION,
    buildHash: getAgentDaemonBuildHash(),
  }

  const server = createHttpServer(async (req, res) => {
    req.on('error', error => {
      void appendDaemonLog(
        `rpc-request-error ${error instanceof Error ? error.message : String(error)}`,
      )
    })
    res.on('error', error => {
      void appendDaemonLog(
        `rpc-response-error ${error instanceof Error ? error.message : String(error)}`,
      )
    })
    if (req.method !== 'POST' || req.url !== '/rpc') {
      writeEmptyRpcResponse(res, 404)
      return
    }
    const auth = req.headers.authorization
    if (auth !== `Bearer ${endpoint.token}`) {
      writeEmptyRpcResponse(res, 401)
      return
    }
    let method = 'unknown'
    try {
      const body = await readRequestBody(req)
      const payload = safeParseJSON(body, false) as AgentDaemonRequest | null
      if (!payload || typeof payload.method !== 'string') {
        throw new Error('Invalid Agent View daemon request.')
      }
      method = payload.method
      const result = await handleAgentDaemonRequest(payload, endpoint)
      if (!writeRpcResponse(res, { ok: true, result })) {
        await appendDaemonLog(`rpc-response-closed method=${method}`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!writeRpcResponse(res, { ok: false, error: message })) {
        await appendDaemonLog(`rpc-error-response-closed method=${method} error=${message}`)
      }
    }
  })
  server.on('clientError', (error, socket) => {
    void appendDaemonLog(`rpc-client-error ${formatAgentViewError(error)}`)
    if (!socket.destroyed) {
      try {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      } catch {
        socket.destroy()
      }
    }
  })

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolvePromise())
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Agent View daemon failed to allocate a local port.')
  }
  endpoint.port = address.port
  await writeAgentDaemonEndpoint(endpoint)
  await appendDaemonLog(`daemon-start pid=${process.pid} port=${endpoint.port}`)

  // Recover persisted jobs after a daemon restart. Stale worker PIDs cannot be
  // reattached, so they become resumable terminal records until the user opens
  // or respawns them.
  for (const state of await readAllAgentStates()) {
    if (state.workerPid && !isProcessRunning(state.workerPid)) {
      await refreshState(state)
    }
  }
  await writeRosterFromStates()

  const housekeeping = setInterval(() => {
    void reapIdleAgentWorkers().catch(error =>
      appendDaemonLog(`housekeeping-error ${error instanceof Error ? error.message : String(error)}`),
    )
    if (
      daemonWorkers.size === 0 &&
      now() - lastDaemonClientAt > AGENT_VIEW_DAEMON_IDLE_EXIT_MS
    ) {
      void appendDaemonLog('daemon-exit idle').finally(() => process.exit(0))
    }
  }, 30_000)

  const cleanup = async () => {
    clearInterval(housekeeping)
    uninstallExceptionHandlers()
    await removeAgentDaemonEndpoint()
    await appendDaemonLog(`daemon-stop pid=${process.pid}`)
  }
  process.once('SIGINT', () => void cleanup().finally(() => process.exit(0)))
  process.once('SIGTERM', () => void cleanup().finally(() => process.exit(0)))
  await new Promise<void>(resolvePromise => {
    server.on('close', () => resolvePromise())
  })
}

async function refreshState(state: AgentJobState): Promise<AgentJobState> {
  if (
    (state.status === 'working' ||
      state.status === 'needs_input' ||
      state.status === 'idle' ||
      state.status === 'completed') &&
    state.workerPid &&
    !isProcessRunning(state.workerPid)
  ) {
    const refreshed = {
      ...state,
      status: state.exitCode === 0 ? 'completed' as const : 'failed' as const,
      workerPid: undefined,
      completedAt: now(),
      updatedAt: now(),
      exitCode: state.exitCode ?? 1,
    }
    await writeAgentState(refreshed)
    return refreshed
  }
  return state
}

export async function listAgentJobs(
  options: ListAgentJobsOptions = {},
): Promise<AgentJobState[]> {
  assertAgentViewEnabled()
  if (!agentViewDaemonRuntime) {
    return (await callAgentDaemon({
      method: 'list',
      cwd: options.cwd,
    })) as AgentJobState[]
  }
  const filterCwd = options.cwd ? normalizePath(options.cwd) : undefined
  const states = await Promise.all((await readAllAgentStates()).map(refreshState))
  await writeRosterFromStates()
  return states
    .filter(state => {
      if (!filterCwd) return true
      return isPathInsideOrEqual(state.rootCwd, filterCwd)
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getAgentJob(ref: string): Promise<AgentJobState> {
  assertAgentViewEnabled()
  if (!agentViewDaemonRuntime) {
    return (await callAgentDaemon({ method: 'get', ref })) as AgentJobState
  }
  const states = await listAgentJobs()
  const matches = states.filter(
    state =>
      state.id === ref ||
      state.id.startsWith(ref) ||
      state.sessionId === ref ||
      state.sessionId.startsWith(ref),
  )
  if (matches.length === 0) {
    throw new Error(`No background session found for "${ref}".`)
  }
  if (matches.length > 1) {
    throw new Error(
      `Session id "${ref}" is ambiguous: ${matches.map(m => m.id).join(', ')}`,
    )
  }
  return matches[0]!
}

async function createDaemonAgentJob(
  options: CreateAgentJobOptions,
  prompt: string,
): Promise<AgentJobState> {
  const existingState = await findAgentStateByClientRequestId(options.clientRequestId)
  if (existingState) {
    const existingWorker = liveDaemonWorkerFor(existingState)
    if (existingWorker) return existingState
    if (existingState.status === 'completed' || existingState.status === 'idle') {
      return existingState
    }

    const recoveryPrompt = existingState.lastPrompt?.trim() || existingState.prompt
    if (existingState.workerPid && isProcessRunning(existingState.workerPid)) {
      await killProcessTree(existingState.workerPid)
      await appendAgentWorkerLog(
        existingState.id,
        `pty-recover-kill stale pid=${existingState.workerPid}`,
      )
    }
    const recoveryState = await updateAgentState(existingState.id, {
      status: 'working',
      lastPrompt: recoveryPrompt,
      startedAt: now(),
      completedAt: undefined,
      exitCode: undefined,
      turnStartedAt: undefined,
      workerPid: undefined,
      daemonPid: process.pid,
      daemonStartedAt: now(),
    })
    const launchedState = await startAgentWorker(
      recoveryState ?? existingState,
      recoveryPrompt,
    )
    await appendDaemonLog(
      `recovered-create job=${existingState.id} request=${options.clientRequestId} pid=${launchedState.workerPid ?? 'unknown'}`,
    )
    return launchedState
  }

  const id = await createUniqueJobId()
  const cwd = normalizePath(options.cwd ?? process.cwd())
  const rootCwd = normalizePath(options.rootCwd ?? cwd)
  const sessionId = options.resumeSessionId ?? randomUUID()
  const jobDir = getAgentJobDir(id)
  const logPath = join(jobDir, 'terminal.log')
  const baseArgs = stripPromptPositionals(
    stripManagedLaunchOptions(options.args ?? []),
  )
  const name = inferDisplayName(prompt || `resume ${sessionId}`, options.name)

  await mkdir(jobDir, { recursive: true, mode: 0o700 })
  const createdAt = now()
  const state: AgentJobState = {
    id,
    sessionId,
    cwd,
    rootCwd,
    prompt,
    status: 'working',
    createdAt,
    updatedAt: createdAt,
    startedAt: createdAt,
    model: options.model,
    effort: options.effort,
    permissionMode: options.permissionMode,
    agent: options.agent,
    name,
    args: baseArgs,
    logPath,
    lastPrompt: prompt,
    resumeSessionId: options.resumeSessionId,
    daemonPid: process.pid,
    daemonStartedAt: now(),
    clientRequestId: options.clientRequestId,
    transport: 'pty-v1',
  }
  await writeAgentState(state)
  const launchedState = await startAgentWorker(state, prompt)
  await appendDaemonLog(
    `started job=${id} session=${sessionId} pid=${launchedState.workerPid ?? 'unknown'} cwd=${cwd}`,
  )
  return launchedState
}

export async function createAgentJob(
  options: CreateAgentJobOptions,
): Promise<AgentJobState> {
  assertAgentViewEnabled()
  if (!agentViewDaemonRuntime) {
    const cwd = normalizePath(options.cwd ?? process.cwd())
    const requestId = options.clientRequestId ?? randomUUID()
    const { clientRequestId: _clientRequestId, ...daemonOptions } = options
    return (await callAgentDaemon({
      method: 'create',
      requestId,
      options: {
        ...daemonOptions,
        cwd,
        rootCwd: normalizePath(options.rootCwd ?? cwd),
      },
    })) as AgentJobState
  }

  const prompt = options.prompt.trim()
  if (prompt.length < 4 && !options.resumeSessionId) {
    throw new Error('Prompt rejected as too short. Describe the task to run.')
  }

  const pendingRequest = options.clientRequestId
    ? pendingCreateRequests.get(options.clientRequestId)
    : undefined
  if (pendingRequest) return await pendingRequest

  const createRequest = createDaemonAgentJob(options, prompt)
  if (!options.clientRequestId) return await createRequest

  pendingCreateRequests.set(options.clientRequestId, createRequest)
  try {
    return await createRequest
  } finally {
    pendingCreateRequests.delete(options.clientRequestId)
  }
}

export async function stopAgentJob(ref: string): Promise<AgentJobState> {
  assertAgentViewEnabled()
  if (!agentViewDaemonRuntime) {
    return (await callAgentDaemon({ method: 'stop', ref })) as AgentJobState
  }
  const state = await getAgentJob(ref)
  await stopManagedWorker(state)
  const updated = await updateAgentState(state.id, {
    status: 'stopped',
    workerPid: undefined,
    completedAt: now(),
    exitCode: null,
  })
  await appendDaemonLog(`stopped job=${state.id}`)
  return updated ?? state
}

async function cleanupAgentJobWorktree(
  state: AgentJobState,
  options: RemoveAgentJobOptions,
): Promise<void> {
  if (!state.worktreePath || state.worktreeRemovedAt) return
  if (!existsSync(state.worktreePath)) return

  if (state.worktreeHookBased) {
    const removed = await removeAgentWorktree(
      state.worktreePath,
      state.worktreeBranch,
      state.worktreeGitRoot,
      true,
    )
    if (!removed) {
      throw new Error(
        `WorktreeRemove hook did not remove ${state.worktreePath}. Keeping session ${state.id}.`,
      )
    }
    return
  }

  if (!state.worktreeHeadCommit) {
    throw new Error(
      `Cannot safely remove worktree for ${state.id}: missing creation commit metadata.`,
    )
  }

  if (
    !options.discardWorktreeChanges &&
    (await hasWorktreeChanges(state.worktreePath, state.worktreeHeadCommit))
  ) {
    throw new Error(
      `Worktree ${state.worktreePath} has changes. Inspect or commit them, then run rm again, or pass --discard-worktree to delete it.`,
    )
  }

  const removed = await removeAgentWorktree(
    state.worktreePath,
    state.worktreeBranch,
    state.worktreeGitRoot,
  )
  if (!removed) {
    throw new Error(`Failed to remove worktree ${state.worktreePath}.`)
  }
}

export async function removeAgentJob(
  ref: string,
  options: RemoveAgentJobOptions = {},
): Promise<AgentJobState> {
  assertAgentViewEnabled()
  if (!agentViewDaemonRuntime) {
    return (await callAgentDaemon({
      method: 'remove',
      ref,
      options,
    })) as AgentJobState
  }
  const state = await getAgentJob(ref)
  if (isAgentJobProcessRunning(state)) {
    throw new Error(`Session ${state.id} is still running. Stop it before rm.`)
  }
  await cleanupAgentJobWorktree(state, options)
  await rm(getAgentJobDir(state.id), { recursive: true, force: true })
  await writeRosterFromStates()
  await appendDaemonLog(`removed job=${state.id}`)
  return state
}

export async function inspectRemoveAgentJob(
  ref: string,
): Promise<RemoveAgentJobDryRun> {
  assertAgentViewEnabled()
  if (!agentViewDaemonRuntime) {
    return (await callAgentDaemon({
      method: 'inspectRemove',
      ref,
    })) as RemoveAgentJobDryRun
  }
  const state = await getAgentJob(ref)
  if (!state.worktreePath || state.worktreeRemovedAt) {
    return {
      state,
      wouldRemoveWorktree: false,
      hasWorktreeChanges: false,
    }
  }
  if (!(await pathIsDirectory(state.worktreePath))) {
    return {
      state,
      wouldRemoveWorktree: false,
      hasWorktreeChanges: false,
      worktreePath: state.worktreePath,
    }
  }
  const hasChanges =
    !state.worktreeHookBased && state.worktreeHeadCommit
      ? await hasWorktreeChanges(state.worktreePath, state.worktreeHeadCommit)
      : false
  return {
    state,
    wouldRemoveWorktree: true,
    hasWorktreeChanges: hasChanges,
    worktreePath: state.worktreePath,
  }
}

export async function updateAgentJobName(
  ref: string,
  name: string,
): Promise<AgentJobState> {
  assertAgentViewEnabled()
  if (!agentViewDaemonRuntime) {
    return (await callAgentDaemon({
      method: 'rename',
      ref,
      name,
    })) as AgentJobState
  }
  const state = await getAgentJob(ref)
  const updated = await updateAgentState(state.id, { name: name.trim() })
  return updated ?? state
}

export async function toggleAgentJobPinned(ref: string): Promise<AgentJobState> {
  assertAgentViewEnabled()
  if (!agentViewDaemonRuntime) {
    return (await callAgentDaemon({ method: 'pin', ref })) as AgentJobState
  }
  const state = await getAgentJob(ref)
  const updated = await updateAgentState(state.id, { pinned: !state.pinned })
  return updated ?? state
}

export async function replyAgentJob(
  ref: string,
  prompt: string,
): Promise<AgentJobState> {
  assertAgentViewEnabled()
  const text = prompt.trim()
  if (!text) {
    throw new Error('Reply rejected as empty.')
  }
  if (!agentViewDaemonRuntime) {
    return (await callAgentDaemon({
      method: 'reply',
      ref,
      prompt: text,
    })) as AgentJobState
  }

  const state = await getAgentJob(ref)
  const worker = liveDaemonWorkerFor(state)
  const updated = await updateAgentState(state.id, {
    status: 'working',
    lastPrompt: text,
    startedAt: now(),
    completedAt: undefined,
    exitCode: undefined,
    turnStartedAt: undefined,
    resumeSessionId: state.sessionId,
    daemonPid: process.pid,
    daemonStartedAt: now(),
  })
  const nextState = updated ?? state

  if (worker) {
    try {
      await queueWorkerControlMessage(
        nextState,
        worker,
        { type: 'submit', text },
        { retryMs: AGENT_VIEW_INITIAL_PROMPT_ACK_TIMEOUT_MS },
      )
    } catch (error) {
      await updateAgentState(state.id, {
        status: 'needs_input',
        lastResult: 'Reply could not be delivered to the background session.',
      })
      throw error
    }
    await appendDaemonLog(`reply job=${state.id}`)
    return (await readAgentState(state.id)) ?? nextState
  }

  const launched = await startAgentWorker(nextState, text)
  await appendDaemonLog(
    `reply-started job=${state.id} session=${state.sessionId} pid=${launched.workerPid ?? 'unknown'}`,
  )
  return launched
}

export async function respawnAgentJob(ref: string): Promise<AgentJobState> {
  assertAgentViewEnabled()
  if (!agentViewDaemonRuntime) {
    return (await callAgentDaemon({ method: 'respawn', ref })) as AgentJobState
  }
  const state = await getAgentJob(ref)
  if (isAgentJobProcessRunning(state)) {
    throw new Error(`Session ${state.id} is already running.`)
  }
  const prompt = 'Continue from where you left off.'
  await updateAgentState(state.id, {
    lastPrompt: prompt,
    status: 'working',
    startedAt: now(),
    completedAt: undefined,
    exitCode: undefined,
    turnStartedAt: undefined,
    resumeSessionId: state.sessionId,
    workerPid: undefined,
  })
  const latest = (await readAgentState(state.id)) ?? state
  const updated = await startAgentWorker(latest, prompt)
  await appendDaemonLog(
    `respawned job=${state.id} session=${state.sessionId} pid=${updated.workerPid ?? 'unknown'}`,
  )
  return updated
}

export async function respawnAllStoppedAgentJobs(): Promise<AgentJobState[]> {
  assertAgentViewEnabled()
  if (!agentViewDaemonRuntime) {
    return (await callAgentDaemon({ method: 'respawnAll' })) as AgentJobState[]
  }
  const states = await listAgentJobs()
  const stopped = states.filter(state =>
    ['stopped', 'failed'].includes(state.status),
  )
  const respawned: AgentJobState[] = []
  for (const state of stopped) {
    respawned.push(await respawnAgentJob(state.id))
  }
  return respawned
}

export async function readAgentLog(
  ref: string,
  options: { bytes?: number } = {},
): Promise<{ state: AgentJobState; text: string }> {
  assertAgentViewEnabled()
  if (!agentViewDaemonRuntime) {
    return (await callAgentDaemon({
      method: 'logs',
      ref,
      bytes: options.bytes,
    })) as { state: AgentJobState; text: string }
  }
  const state = await getAgentJob(ref)
  const bytes = options.bytes ?? AGENT_VIEW_LOG_TAIL_BYTES
  try {
    const stat = statSync(state.logPath)
    const start = Math.max(0, stat.size - bytes)
    const chunks: Buffer[] = []
    await new Promise<void>((resolvePromise, reject) => {
      const stream = createReadStream(state.logPath, { start })
      stream.on('data', chunk => chunks.push(Buffer.from(chunk)))
      stream.on('error', reject)
      stream.on('end', () => resolvePromise())
    })
    return { state, text: renderAgentLogText(Buffer.concat(chunks).toString('utf8')) }
  } catch {
    return { state, text: '' }
  }
}

export async function readAgentLogRaw(
  ref: string,
  options: { bytes?: number } = {},
): Promise<{ state: AgentJobState; text: string }> {
  assertAgentViewEnabled()
  if (!agentViewDaemonRuntime) {
    return (await callAgentDaemon({
      method: 'logs',
      ref,
      bytes: options.bytes,
      raw: true,
    })) as { state: AgentJobState; text: string }
  }
  const state = await getAgentJob(ref)
  const bytes = options.bytes ?? AGENT_VIEW_LOG_TAIL_BYTES
  try {
    const fileStat = statSync(state.logPath)
    const start = Math.max(0, fileStat.size - bytes)
    const chunks: Buffer[] = []
    await new Promise<void>((resolvePromise, reject) => {
      const stream = createReadStream(state.logPath, { start })
      stream.on('data', chunk => chunks.push(Buffer.from(chunk)))
      stream.on('error', reject)
      stream.on('end', () => resolvePromise())
    })
    return { state, text: Buffer.concat(chunks).toString('utf8') }
  } catch {
    return { state, text: '' }
  }
}

function getCurrentTerminalSize(): { cols: number; rows: number } {
  return {
    cols: process.stdout.columns || AGENT_VIEW_DEFAULT_COLS,
    rows: process.stdout.rows || AGENT_VIEW_DEFAULT_ROWS,
  }
}

async function prepareAgentJobSession(
  ref: string,
  size: { cols?: number; rows?: number } = {},
): Promise<AgentPtyAttachInfo> {
  assertAgentViewEnabled()
  if (!agentViewDaemonRuntime) {
    return (await callAgentDaemon({
      method: 'prepareOpen',
      ref,
      cols: size.cols,
      rows: size.rows,
    })) as AgentPtyAttachInfo
  }

  const state = await getAgentJob(ref)
  const existing = daemonWorkers.get(state.id)
  const workerState = existing && !existing.exited && isProcessRunning(existing.pty.pid)
    ? state
    : await startAgentWorker(
        {
          ...state,
          resumeSessionId: state.sessionId,
        },
        '',
        size,
      )
  const worker = daemonWorkers.get(state.id)
  if (!worker) throw new Error(`Background session ${state.id} has no PTY worker.`)
  const updated = await updateAgentState(state.id, {
    workerPid: worker.pty.pid,
    daemonPid: process.pid,
    ptySocketPath: worker.socketPath,
    ptyToken: worker.token,
    terminalCols: size.cols ?? workerState.terminalCols,
    terminalRows: size.rows ?? workerState.terminalRows,
  })
  await appendDaemonLog(`pty-attach job=${state.id}`)
  return {
    state: updated ?? state,
    socketPath: worker.socketPath,
    token: worker.token,
  }
}

async function finishAgentJobSession(
  ref: string,
  result: { code: number | null; returnedToAgentView: boolean },
): Promise<AgentJobState> {
  assertAgentViewEnabled()
  if (!agentViewDaemonRuntime) {
    return (await callAgentDaemon({
      method: 'finishOpen',
      ref,
      code: result.code,
      returnedToAgentView: result.returnedToAgentView,
    })) as AgentJobState
  }

  const state = await getAgentJob(ref)
  const updated = await updateAgentState(state.id, {
    attached: false,
    attachedPid: undefined,
    daemonPid: process.pid,
  })
  await appendDaemonLog(
    `open-session-finish job=${state.id} code=${result.code ?? 'unknown'} returned=${result.returnedToAgentView}`,
  )
  return updated ?? state
}

async function bridgeAgentPtySession(
  info: AgentPtyAttachInfo,
  options: { returnToAgentViewOnAttachFailure?: boolean } = {},
): Promise<{ code: number | null; returnedToAgentView: boolean }> {
  const socket = createConnection(info.socketPath)
  const stdin = process.stdin as NodeJS.ReadStream & {
    isRaw?: boolean
    setRawMode?: (mode: boolean) => void
    setEncoding?: (encoding: BufferEncoding) => void
    ref?: () => void
    unref?: () => void
  }
  const size = getCurrentTerminalSize()

  return await new Promise(resolvePromise => {
    let settled = false
    let attached = false
    let attachTimer: ReturnType<typeof setTimeout> | undefined
    const pendingInput: Buffer[] = []
    let localInput = ''
    let localCursor = 0
    let inputCarry = ''
    let detachRequested = false
    const settle = (result: { code: number | null; returnedToAgentView: boolean }) => {
      if (settled) return
      settled = true
      cleanup()
      resolvePromise(result)
    }
    const sendResize = () => {
      writeFrame(socket, {
        type: 'resize',
        cols: process.stdout.columns || size.cols,
        rows: process.stdout.rows || size.rows,
      })
    }
    const forwardInput = (data: Buffer) => {
      writeFrame(socket, { type: 'input', data: encodePtyData(data) })
    }
    const syncPromptInput = () => {
      writeFrame(socket, {
        type: 'input_state',
        text: localInput,
        cursor: localCursor,
      })
    }
    const submitPrompt = () => {
      const text = localInput.trim()
      localInput = ''
      localCursor = 0
      syncPromptInput()
      if (text) {
        writeFrame(socket, { type: 'submit_prompt', text })
      } else {
        forwardInput(Buffer.from('\r'))
      }
    }
    const moveLocalCursor = (delta: number) => {
      const next = Math.max(0, Math.min(localInput.length, localCursor + delta))
      localCursor = next
      syncPromptInput()
    }
    const insertLocalText = (text: string) => {
      if (!text) return
      const suffix = localInput.slice(localCursor)
      localInput = `${localInput.slice(0, localCursor)}${text}${suffix}`
      localCursor += text.length
      syncPromptInput()
    }
    const deleteLocalBackward = () => {
      if (localCursor === 0) return
      const suffix = localInput.slice(localCursor)
      localInput = `${localInput.slice(0, localCursor - 1)}${suffix}`
      localCursor -= 1
      syncPromptInput()
    }
    const detachFromLocalPrompt = () => {
      detachRequested = true
      writeFrame(socket, { type: 'detach' })
      settle({ code: null, returnedToAgentView: true })
    }
    const handleTerminalInput = (text: string) => {
      for (let i = 0; i < text.length;) {
        if (text.startsWith('\x1b[200~', i)) {
          const end = text.indexOf('\x1b[201~', i + 6)
          if (end !== -1) {
            insertLocalText(text.slice(i + 6, end))
            i = end + 6
            continue
          }
        }
        const leftArrowMatch = /^\x1b\[[0-9;]*D/.exec(text.slice(i))
        if (leftArrowMatch) {
          if (localInput.length === 0 && localCursor === 0) {
            detachFromLocalPrompt()
          } else {
            moveLocalCursor(-1)
          }
          i += leftArrowMatch[0].length
          continue
        }
        if (text.startsWith('\x1bOD', i)) {
          if (localInput.length === 0 && localCursor === 0) {
            detachFromLocalPrompt()
          } else {
            moveLocalCursor(-1)
          }
          i += 3
          continue
        }
        const rightArrowMatch = /^\x1b\[[0-9;]*C/.exec(text.slice(i))
        if (rightArrowMatch) {
          moveLocalCursor(1)
          i += rightArrowMatch[0].length
          continue
        }
        if (text.startsWith('\x1bOC', i)) {
          moveLocalCursor(1)
          i += 3
          continue
        }
        const csiMatch = /^\x1b\[[0-9;?]*[ -/]*[@-~]/.exec(text.slice(i))
        if (csiMatch) {
          forwardInput(Buffer.from(csiMatch[0]))
          i += csiMatch[0].length
          continue
        }
        const ss3Match = /^\x1bO./.exec(text.slice(i))
        if (ss3Match) {
          forwardInput(Buffer.from(ss3Match[0]))
          i += ss3Match[0].length
          continue
        }
        const codePoint = text.codePointAt(i)
        if (codePoint === undefined) break
        const char = String.fromCodePoint(codePoint)
        i += char.length
        if (char === '\r' || char === '\n') {
          submitPrompt()
        } else if (char === '\x7f' || char === '\b') {
          deleteLocalBackward()
        } else if (char === '\x03') {
          forwardInput(Buffer.from(char))
        } else if (char >= ' ') {
          insertLocalText(char)
        } else {
          forwardInput(Buffer.from(char))
        }
      }
    }
    const getIncompleteInputSuffixLength = (text: string): number => {
      if (text.endsWith('\x1b[200~')) return 6
      if (text.endsWith('\x1b[201~')) return 6
      if (text.endsWith('\x1b[20')) return 5
      if (text.endsWith('\x1b[2')) return 4
      if (text.endsWith('\x1b[') || text.endsWith('\x1bO')) return 2
      if (text.endsWith('\x1b')) return 1
      return 0
    }
    const onInput = (chunk: Buffer | string) => {
      if (attached) {
        let text = `${inputCarry}${typeof chunk === 'string' ? chunk : chunk.toString('utf8')}`
        inputCarry = ''
        const carryLength = getIncompleteInputSuffixLength(text)
        if (carryLength > 0) {
          inputCarry = text.slice(text.length - carryLength)
          text = text.slice(0, text.length - carryLength)
        }
        if (text) handleTerminalInput(text)
      } else {
        pendingInput.push(Buffer.from(chunk))
      }
    }
    const onReadable = () => {
      let chunk: Buffer | string | null
      while ((chunk = stdin.read()) !== null) {
        onInput(chunk)
      }
    }
    const cleanup = () => {
      if (attachTimer) clearTimeout(attachTimer)
      socket.off('error', onError)
      socket.off('close', onClose)
      socket.destroy()
      process.stdout.off('resize', sendResize)
      stdin.off('readable', onReadable)
      stdin.removeAllListeners('data')
      stdin.removeAllListeners('keypress')
      if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(false)
      stdin.pause()
    }
    const onClose = () => {
      settle({
        code: attached ? null : 1,
        returnedToAgentView:
          detachRequested || Boolean(options.returnToAgentViewOnAttachFailure),
      })
    }
    const onError = () => {
      settle({
        code: 1,
        returnedToAgentView:
          !attached && Boolean(options.returnToAgentViewOnAttachFailure),
      })
    }
    const startTerminalBridge = () => {
      process.stdout.on('resize', sendResize)
      stdin.setEncoding?.('utf8')
      stdin.ref?.()
      if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(true)
      stdin.on('readable', onReadable)
      stdin.resume()
    }
    startTerminalBridge()

    onFrames(socket, frame => {
      if (frame.type === 'attached') {
        attached = true
        if (attachTimer) {
          clearTimeout(attachTimer)
          attachTimer = undefined
        }
        sendResize()
        forwardInput(Buffer.from('\x0c'))
        for (const data of pendingInput.splice(0)) {
          handleTerminalInput(data.toString('utf8'))
        }
      } else if (frame.type === 'error') {
        process.stderr.write(`Agent View attach failed: ${frame.message}\n`)
        settle({ code: 1, returnedToAgentView: false })
      } else if (frame.type === 'output') {
        process.stdout.write(decodePtyData(frame.data))
      } else if (frame.type === 'detach') {
        detachRequested = true
        settle({ code: null, returnedToAgentView: true })
      } else if (frame.type === 'exit') {
        settle({ code: frame.code, returnedToAgentView: false })
      }
    })
    socket.on('connect', () => {
      writeFrame(socket, { type: 'hello', token: info.token, pid: process.pid })
    })
    socket.on('error', onError)
    socket.on('close', onClose)
    attachTimer = setTimeout(() => {
      process.stderr.write('Agent View attach timed out before the PTY became ready.\n')
      settle({
        code: 1,
        returnedToAgentView: Boolean(options.returnToAgentViewOnAttachFailure),
      })
    }, AGENT_VIEW_ATTACH_TIMEOUT_MS)
  })
}

export async function openAgentJobSession(
  ref: string,
  options: { returnToAgentView?: boolean } = {},
): Promise<{ code: number | null; returnedToAgentView: boolean }> {
  assertAgentViewEnabled()
  const size = getCurrentTerminalSize()
  const info = await prepareAgentJobSession(ref, size)
  const result = await bridgeAgentPtySession(info, {
    returnToAgentViewOnAttachFailure: options.returnToAgentView !== false,
  })
  await finishAgentJobSession(info.state.id, result)
  if (result.code && result.code !== 0 && !result.returnedToAgentView) {
    throw new Error(`Session exited with code ${result.code}`)
  }
  return options.returnToAgentView === false
    ? { ...result, returnedToAgentView: false }
    : result
}

export async function attachAgentJob(ref: string): Promise<void> {
  assertAgentViewEnabled()
  await openAgentJobSession(ref, { returnToAgentView: false })
}

export function renderAgentLogText(text: string): string {
  return stripAnsi(text)
}

export function formatAgentJobLine(state: AgentJobState): string {
  const status = state.status.padEnd(16)
  const id = state.id.padEnd(8)
  const name = state.name || state.prompt || state.sessionId
  return `${id} ${status} ${basename(state.rootCwd)}  ${name}`
}

export function groupAgentJobs(
  jobs: AgentJobState[],
  mode: AgentViewGroupMode,
): Array<{ label: string; jobs: AgentJobState[] }> {
  if (mode === 'directory') {
    const byDir = new Map<string, AgentJobState[]>()
    for (const job of jobs) {
      const key = job.rootCwd
      byDir.set(key, [...(byDir.get(key) ?? []), job])
    }
    return [...byDir.entries()].map(([label, groupedJobs]) => ({
      label,
      jobs: groupedJobs,
    }))
  }

  const order: AgentJobState['status'][] = [
    'needs_input',
    'ready_for_review',
    'working',
    'idle',
    'failed',
    'stopped',
    'completed',
  ]
  const pinned = jobs.filter(job => job.pinned)
  const unpinned = jobs.filter(job => !job.pinned)
  return [
    ...(pinned.length > 0 ? [{ label: 'pinned', jobs: pinned }] : []),
    ...order
    .map(status => ({
      label: status,
      jobs: unpinned.filter(job => job.status === status),
    }))
    .filter(group => group.jobs.length > 0),
  ]
}

function parseAgentViewStatus(value: string): AgentViewStatus | undefined {
  const statuses: AgentViewStatus[] = [
    'working',
    'needs_input',
    'idle',
    'ready_for_review',
    'completed',
    'failed',
    'stopped',
  ]
  return statuses.includes(value as AgentViewStatus)
    ? (value as AgentViewStatus)
    : undefined
}

export function parseAgentViewFilter(query: string): AgentViewFilter {
  const filter: AgentViewFilter = {}
  const textParts: string[] = []
  for (const rawPart of query.trim().split(/\s+/)) {
    if (!rawPart) continue
    const [prefix, ...rest] = rawPart.split(':')
    const value = rest.join(':')
    if (prefix === 'a' && value) {
      filter.agent = value.toLowerCase()
      continue
    }
    if (prefix === 's' && value) {
      filter.status = parseAgentViewStatus(
        value === 'blocked' ? 'needs_input' : value,
      )
      continue
    }
    const prUrlMatch = rawPart.match(/\/pull\/(\d+)/)
    if (prUrlMatch?.[1]) {
      filter.pr = prUrlMatch[1].toLowerCase()
      continue
    }
    if (rawPart.startsWith('#') && rawPart.length > 1) {
      filter.pr = rawPart.slice(1).toLowerCase()
      continue
    }
    textParts.push(rawPart)
  }
  if (textParts.length > 0) filter.text = textParts.join(' ').toLowerCase()
  return filter
}

export function looksLikeAgentViewFilter(query: string): boolean {
  return query
    .trim()
    .split(/\s+/)
    .some(part =>
      part.startsWith('a:') ||
      part.startsWith('s:') ||
      /^#\d+/.test(part) ||
      /\/pull\/\d+/.test(part),
    )
}

export function filterAgentJobs(
  jobs: AgentJobState[],
  filter: AgentViewFilter,
): AgentJobState[] {
  return jobs.filter(job => {
    if (filter.agent && !(job.agent ?? '').toLowerCase().includes(filter.agent)) {
      return false
    }
    if (filter.status && job.status !== filter.status) return false
    if (filter.pr) {
      const haystack = [
        job.name,
        job.prompt,
        job.lastPrompt,
        job.worktreeBranch,
        job.rootCwd,
        job.cwd,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      if (!haystack.includes(`#${filter.pr}`) && !haystack.includes(filter.pr)) {
        return false
      }
    }
    if (filter.text) {
      const haystack = [
        job.id,
        job.sessionId,
        job.status,
        job.name,
        job.prompt,
        job.lastPrompt,
        job.agent,
        basename(job.rootCwd),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      if (!haystack.includes(filter.text)) return false
    }
    return true
  })
}

export function getCurrentSessionIdForBackground(): string {
  return getSessionId()
}
