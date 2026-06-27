import type {
  BackendSession,
  DangerousBackend,
} from './backends/dangerousBackend.js'
import {
  SessionIndexStore,
  transcriptExistsForSession,
} from './sessionIndex.js'
import type { SessionIndexEntry } from './types.js'

const MAX_BUFFERED_LINES = 2_000

export type SessionClient = {
  id: string
  send(line: string): void
  close(code?: number, reason?: string): void
}

export class SessionManagerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'SessionManagerError'
  }
}

type ManagedSession = {
  id: string
  workDir: string
  backendSession: BackendSession
  lineBuffer: string[]
  attachedClient?: SessionClient
  idleTimer?: NodeJS.Timeout
  destroying: boolean
  sessionKey?: string
  permissionMode?: string
  transcriptSessionId: string
  removeLineListener: () => void
  removeExitListener: () => void
}

export class SessionManager {
  private readonly sessions = new Map<string, ManagedSession>()
  private readonly sessionIndex = new SessionIndexStore()
  private startingSessions = 0

  constructor(
    private readonly backend: DangerousBackend,
    private readonly options: {
      idleTimeoutMs?: number
      maxSessions?: number
    } = {},
  ) {}

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  canAttach(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    return !!session && !session.destroying && !session.attachedClient
  }

  async createSession(options: {
    cwd: string
    dangerouslySkipPermissions?: boolean
    permissionMode?: string
    sessionKey?: string
  }): Promise<{
    sessionId: string
    workDir: string
  }> {
    const indexedEntry = await this.getSessionIndexEntry(options.sessionKey)
    if (options.sessionKey && indexedEntry) {
      const liveSession = this.sessions.get(indexedEntry.sessionId)
      if (liveSession && !liveSession.destroying) {
        await this.updateSessionIndex(liveSession)
        return {
          sessionId: liveSession.id,
          workDir: liveSession.workDir,
        }
      }
    }
    const existingEntry = await this.resolveExistingEntry(
      options.sessionKey,
      indexedEntry,
    )

    this.ensureCapacity()
    this.startingSessions += 1

    const resolvedCwd = existingEntry?.cwd ?? options.cwd
    const resolvedPermissionMode =
      options.permissionMode ?? existingEntry?.permissionMode
    const resumeSessionId = existingEntry?.transcriptSessionId

    const backendSession = this.backend.createSession({
      cwd: resolvedCwd,
      dangerouslySkipPermissions: options.dangerouslySkipPermissions,
      permissionMode: resolvedPermissionMode,
      resumeSessionId,
    })
    const managed: ManagedSession = {
      id: '',
      workDir: resolvedCwd,
      backendSession,
      lineBuffer: [],
      destroying: false,
      sessionKey: options.sessionKey,
      permissionMode: resolvedPermissionMode,
      transcriptSessionId: resumeSessionId ?? '',
      removeLineListener: () => {},
      removeExitListener: () => {},
    }

    managed.removeLineListener = backendSession.onLine(line => {
      if (managed.destroying) {
        return
      }

      if (managed.attachedClient) {
        managed.attachedClient.send(line)
        return
      }

      managed.lineBuffer.push(line)
      if (managed.lineBuffer.length > MAX_BUFFERED_LINES) {
        managed.lineBuffer.splice(
          0,
          managed.lineBuffer.length - MAX_BUFFERED_LINES,
        )
      }
    })

    managed.removeExitListener = backendSession.onExit(() => {
      void this.destroySession(managed, 1011, 'Session ended')
    })

    try {
      const ready = await backendSession.waitUntilReady()
      managed.id = ready.sessionId
      managed.workDir = ready.workDir
      managed.transcriptSessionId = resumeSessionId ?? ready.sessionId
      this.sessions.set(ready.sessionId, managed)
      this.scheduleIdleTimeout(managed)
      await this.persistSessionIndex(managed, existingEntry)
      return ready
    } catch (error) {
      managed.destroying = true
      await backendSession.destroy().catch(() => {})
      throw error
    } finally {
      this.startingSessions -= 1
    }
  }

  attachClient(sessionId: string, client: SessionClient): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.destroying) {
      throw new SessionManagerError(404, 'Unknown session')
    }
    if (session.attachedClient) {
      throw new SessionManagerError(409, 'Session already has an attached client')
    }

    this.clearIdleTimeout(session)
    session.attachedClient = client
    this.touchSessionIndex(session)

    for (const line of session.lineBuffer.splice(0)) {
      client.send(line)
    }
  }

  detachClient(sessionId: string, clientId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.attachedClient?.id !== clientId) {
      return
    }

    session.attachedClient = undefined
    this.scheduleIdleTimeout(session)
    this.touchSessionIndex(session)
  }

  handleClientMessage(sessionId: string, data: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session || session.destroying) {
      return false
    }
    const ok = session.backendSession.sendLine(data)
    if (ok) {
      this.touchSessionIndex(session)
    }
    return ok
  }

  async destroyAll(): Promise<void> {
    await Promise.all(
      [...this.sessions.values()].map(session =>
        this.destroySession(session, 1001, 'Server shutdown'),
      ),
    )
  }

  private ensureCapacity(): void {
    const maxSessions = this.options.maxSessions ?? 0
    if (maxSessions <= 0) {
      return
    }

    if (this.sessions.size + this.startingSessions >= maxSessions) {
      throw new SessionManagerError(
        429,
        `Maximum concurrent session limit reached (${maxSessions})`,
      )
    }
  }

  private scheduleIdleTimeout(session: ManagedSession): void {
    this.clearIdleTimeout(session)

    const idleTimeoutMs = this.options.idleTimeoutMs ?? 0
    if (idleTimeoutMs <= 0 || session.attachedClient || session.destroying) {
      return
    }

    session.idleTimer = setTimeout(() => {
      void this.destroySession(session, 1001, 'Idle timeout')
    }, idleTimeoutMs)
  }

  private clearIdleTimeout(session: ManagedSession): void {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer)
      session.idleTimer = undefined
    }
  }

  private async destroySession(
    session: ManagedSession,
    closeCode: number,
    closeReason: string,
  ): Promise<void> {
    if (session.destroying) {
      return
    }
    session.destroying = true

    this.clearIdleTimeout(session)
    this.sessions.delete(session.id)
    session.removeLineListener()
    session.removeExitListener()

    if (session.attachedClient) {
      session.attachedClient.close(closeCode, closeReason)
      session.attachedClient = undefined
    }

    await this.updateSessionIndex(session)
    await session.backendSession.destroy().catch(() => {})
  }

  private async resolveExistingEntry(
    sessionKey: string | undefined,
    entry: SessionIndexEntry | undefined,
  ): Promise<SessionIndexEntry | undefined> {
    if (!sessionKey || !entry) {
      return undefined
    }

    const transcriptExists = await transcriptExistsForSession(
      entry.cwd,
      entry.transcriptSessionId,
    )
    if (transcriptExists) {
      return entry
    }

    await this.sessionIndex.delete(sessionKey)
    return undefined
  }

  private async getSessionIndexEntry(
    sessionKey: string | undefined,
  ): Promise<SessionIndexEntry | undefined> {
    if (!sessionKey) {
      return undefined
    }
    return this.sessionIndex.get(sessionKey)
  }

  private async persistSessionIndex(
    session: ManagedSession,
    existingEntry: SessionIndexEntry | undefined,
  ): Promise<void> {
    if (!session.sessionKey || !session.id) {
      return
    }

    const now = Date.now()
    await this.sessionIndex.set(session.sessionKey, {
      sessionId: session.id,
      transcriptSessionId: session.transcriptSessionId || session.id,
      cwd: session.workDir,
      permissionMode: session.permissionMode,
      createdAt: existingEntry?.createdAt ?? now,
      lastActiveAt: now,
    })
  }

  private async updateSessionIndex(session: ManagedSession): Promise<void> {
    if (!session.sessionKey || !session.id) {
      return
    }

    await this.sessionIndex.touch(session.sessionKey, {
      sessionId: session.id,
      transcriptSessionId: session.transcriptSessionId || session.id,
      cwd: session.workDir,
      permissionMode: session.permissionMode,
      lastActiveAt: Date.now(),
    })
  }

  private touchSessionIndex(session: ManagedSession): void {
    void this.updateSessionIndex(session)
  }
}
