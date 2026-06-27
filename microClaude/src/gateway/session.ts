import { randomUUID } from 'crypto'
import type { SDKResultMessage } from '../entrypoints/agentSdkTypes.js'
import type {
  SDKControlPermissionRequest,
  StdoutMessage,
} from '../entrypoints/sdk/controlTypes.js'
import type { BackendSession } from '../server/backends/dangerousBackend.js'
import { DangerousBackend } from '../server/backends/dangerousBackend.js'
import { errorMessage } from '../utils/errors.js'
import { jsonParse, jsonStringify } from '../utils/slowOperations.js'
import type { GatewayLogger } from './logger.js'
import type {
  GatewayPermissionMode,
  GatewayTurnUpdate,
  GatewayTurnResult,
} from './types.js'

type GatewaySessionOptions = {
  workspace: string
  dangerouslySkipPermissions: boolean
  permissionMode: GatewayPermissionMode
  turnTimeoutMs: number
  resumeSessionId?: string
}

type PendingTurn = {
  resolve: (result: GatewayTurnResult) => void
  reject: (error: unknown) => void
  timer: NodeJS.Timeout
  onUpdate?: (update: GatewayTurnUpdate) => void
  updateSequence: number
  streamedText: string
  blockTexts: Map<number, string>
}

function isStdoutMessage(value: unknown): value is StdoutMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof (value as { type?: unknown }).type === 'string'
  )
}

function formatResultError(message: SDKResultMessage): string {
  const result = message as SDKResultMessage & {
    errors?: string[]
    result?: string
  }
  if (Array.isArray(result.errors) && result.errors.length > 0) {
    return result.errors.join('\n')
  }
  if (typeof result.result === 'string' && result.result.trim()) {
    return result.result
  }
  return `Turn failed with subtype ${message.subtype}`
}

function mergeStreamingText(previousText: string, nextText: string): string {
  if (!nextText) {
    return previousText
  }
  if (!previousText || nextText === previousText) {
    return nextText
  }
  if (nextText.startsWith(previousText)) {
    return nextText
  }
  if (previousText.startsWith(nextText)) {
    return previousText
  }
  if (nextText.includes(previousText)) {
    return nextText
  }
  if (previousText.includes(nextText)) {
    return previousText
  }

  const maxOverlap = Math.min(previousText.length, nextText.length)
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (previousText.slice(-overlap) === nextText.slice(0, overlap)) {
      return `${previousText}${nextText.slice(overlap)}`
    }
  }

  return `${previousText}${nextText}`
}

function isTextDeltaEvent(
  value: StdoutMessage,
): value is StdoutMessage & {
  type: 'stream_event'
  event: {
    type: 'content_block_delta'
    index: number
    delta: {
      type: 'text_delta'
      text: string
    }
  }
} {
  if (value.type !== 'stream_event') {
    return false
  }

  const event = (value as { event?: unknown }).event
  if (typeof event !== 'object' || event === null) {
    return false
  }

  const typedEvent = event as {
    type?: unknown
    index?: unknown
    delta?: {
      type?: unknown
      text?: unknown
    }
  }

  return (
    typedEvent.type === 'content_block_delta' &&
    typeof typedEvent.index === 'number' &&
    typedEvent.delta?.type === 'text_delta' &&
    typeof typedEvent.delta.text === 'string'
  )
}

export class GatewaySession {
  private readonly backendSession: BackendSession
  private readonly ready: Promise<{ sessionId: string; workDir: string }>
  private queue: Promise<unknown> = Promise.resolve()
  private pendingTurn?: PendingTurn
  private destroyed = false
  private readonly sessionIdPromise: Promise<string>
  private readonly workDirPromise: Promise<string>
  private sessionIdValue?: string
  private readonly transcriptSessionIdPromise: Promise<string>
  private lastActiveAt = Date.now()
  private pendingTurns = 0

  constructor(
    private readonly logger: GatewayLogger,
    private readonly options: GatewaySessionOptions,
  ) {
    const backend = new DangerousBackend()
    this.backendSession = backend.createSession({
      cwd: options.workspace,
      dangerouslySkipPermissions: options.dangerouslySkipPermissions,
      permissionMode: options.permissionMode,
      resumeSessionId: options.resumeSessionId,
    })
    this.ready = this.backendSession.waitUntilReady()
    this.sessionIdPromise = this.ready.then(ready => {
      this.sessionIdValue = ready.sessionId
      return ready.sessionId
    })
    this.workDirPromise = this.ready.then(ready => ready.workDir)
    this.transcriptSessionIdPromise = this.sessionIdPromise.then(sessionId =>
      options.resumeSessionId ?? sessionId,
    )

    this.backendSession.onLine(line => {
      this.lastActiveAt = Date.now()
      this.handleLine(line)
    })
    this.backendSession.onExit(event => {
      this.rejectPendingTurn(
        new Error(
          event.error
            ? errorMessage(event.error)
            : `Gateway session exited (code=${event.code}, signal=${event.signal ?? 'none'})`,
        ),
      )
    })
  }

  get idleForMs(): number {
    return Date.now() - this.lastActiveAt
  }

  isBusy(): boolean {
    return this.pendingTurns > 0 || this.pendingTurn !== undefined
  }

  async getSessionId(): Promise<string> {
    return this.sessionIdPromise
  }

  async getWorkDir(): Promise<string> {
    return this.workDirPromise
  }

  async getTranscriptSessionId(): Promise<string> {
    return this.transcriptSessionIdPromise
  }

  async submit(
    content: string,
    onUpdate?: (update: GatewayTurnUpdate) => void,
  ): Promise<GatewayTurnResult> {
    const run = async (): Promise<GatewayTurnResult> => {
      await this.ready
      return this.executeTurn(content, onUpdate)
    }

    this.pendingTurns += 1
    const queued = this.queue.then(run, run)
    this.queue = queued.catch(() => undefined)

    return queued.finally(() => {
      this.pendingTurns = Math.max(0, this.pendingTurns - 1)
      this.lastActiveAt = Date.now()
    })
  }

  async close(): Promise<void> {
    if (this.destroyed) {
      return
    }
    this.destroyed = true
    this.rejectPendingTurn(new Error('Gateway session closed'))
    await this.backendSession.destroy().catch(error => {
      this.logger.warn(`Failed to destroy gateway session: ${errorMessage(error)}`)
    })
  }

  private executeTurn(
    content: string,
    onUpdate?: (update: GatewayTurnUpdate) => void,
  ): Promise<GatewayTurnResult> {
    if (this.pendingTurn) {
      throw new Error('Gateway session turn overlap detected')
    }

    return new Promise<GatewayTurnResult>((resolve, reject) => {
      void this.getSessionId().then(
        sessionId => {
          const timer = setTimeout(() => {
            this.sendInterrupt()
            this.rejectPendingTurn(
              new Error(
                `Gateway turn timed out after ${this.options.turnTimeoutMs}ms`,
              ),
            )
          }, this.options.turnTimeoutMs)

          this.pendingTurn = {
            resolve,
            reject,
            timer,
            onUpdate,
            updateSequence: 0,
            streamedText: '',
            blockTexts: new Map(),
          }

          const ok = this.backendSession.sendLine(
            jsonStringify({
              type: 'user',
              session_id: sessionId,
              parent_tool_use_id: null,
              message: {
                role: 'user',
                content,
              },
            }),
          )
          if (!ok) {
            this.rejectPendingTurn(
              new Error('Failed to write to gateway session'),
            )
          }
        },
        error => {
          reject(error)
        },
      )
    })
  }

  private handleLine(line: string): void {
    if (!line.trim()) {
      return
    }

    let parsed: unknown
    try {
      parsed = jsonParse(line)
    } catch {
      return
    }

    if (!isStdoutMessage(parsed)) {
      return
    }

    if (parsed.type === 'control_request') {
      this.handleControlRequest(parsed.request_id, parsed.request)
      return
    }

    if (isTextDeltaEvent(parsed) && this.pendingTurn?.onUpdate) {
      this.handleStreamTextDelta(parsed)
      return
    }

    if (parsed.type === 'result') {
      if (!this.pendingTurn) {
        return
      }
      const pending = this.pendingTurn
      const result = parsed as SDKResultMessage & { result?: string }
      this.pendingTurn = undefined
      clearTimeout(pending.timer)
      if (result.is_error) {
        pending.reject(new Error(formatResultError(result)))
        return
      }
      pending.resolve({
        sessionId: this.sessionIdValue ?? '',
        message: result.result ?? '',
      })
    }
  }

  private handleControlRequest(
    requestId: string,
    request: SDKControlPermissionRequest | { subtype?: string },
  ): void {
    if (request.subtype !== 'can_use_tool') {
      this.sendErrorResponse(
        requestId,
        `Unsupported control request subtype: ${String(request.subtype ?? 'unknown')}`,
      )
      return
    }

    this.sendSuccessResponse(requestId, {
      behavior: 'deny',
      message:
        'Gateway sessions do not provide an interactive tool permission bridge. Use dontAsk, bypassPermissions, or dangerouslySkipPermissions for unattended gateway sessions.',
    })
  }

  private sendInterrupt(): void {
    this.backendSession.sendLine(
      jsonStringify({
        type: 'control_request',
        request_id: randomUUID(),
        request: { subtype: 'interrupt' },
      }),
    )
  }

  private sendSuccessResponse(
    requestId: string,
    response:
      | { behavior: 'allow'; updatedInput: Record<string, unknown> }
      | { behavior: 'deny'; message: string },
  ): void {
    this.backendSession.sendLine(
      jsonStringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: requestId,
          response,
        },
      }),
    )
  }

  private sendErrorResponse(requestId: string, error: string): void {
    this.backendSession.sendLine(
      jsonStringify({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: requestId,
          error,
        },
      }),
    )
  }

  private handleStreamTextDelta(
    message: StdoutMessage & {
      type: 'stream_event'
      event: {
        type: 'content_block_delta'
        index: number
        delta: {
          type: 'text_delta'
          text: string
        }
      }
    },
  ): void {
    const pending = this.pendingTurn
    if (!pending?.onUpdate) {
      return
    }

    const currentText = pending.blockTexts.get(message.event.index) ?? ''
    pending.blockTexts.set(
      message.event.index,
      mergeStreamingText(currentText, message.event.delta.text),
    )

    const aggregatedText = [...pending.blockTexts.entries()]
      .sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
      .map(([, text]) => text)
      .join('')

    if (!aggregatedText || aggregatedText === pending.streamedText) {
      return
    }

    pending.streamedText = aggregatedText
    pending.updateSequence += 1
    pending.onUpdate({
      text: aggregatedText,
      sequence: pending.updateSequence,
    })
  }

  private rejectPendingTurn(error: unknown): void {
    if (!this.pendingTurn) {
      return
    }
    const pending = this.pendingTurn
    this.pendingTurn = undefined
    clearTimeout(pending.timer)
    pending.reject(error)
  }
}
