import {
  SessionIndexStore,
  transcriptExistsForSession,
} from '../server/sessionIndex.js'
import type { SessionIndexEntry } from '../server/types.js'
import type { GatewayLogger } from './logger.js'
import { GatewaySession } from './session.js'
import type {
  GatewayInboundEvent,
  GatewayPermissionMode,
  GatewaySessionKeyStrategy,
  GatewayTurnUpdate,
  GatewayTurnResult,
} from './types.js'

type GatewaySessionRouterOptions = {
  workspace: string
  dangerouslySkipPermissions: boolean
  permissionMode: GatewayPermissionMode
  turnTimeoutMs: number
  sessionIdleTimeoutMs: number
  sessionKeyStrategy: GatewaySessionKeyStrategy
}

type RoutedSession = {
  key: string
  session: GatewaySession
  createdAt: number
}

export class GatewaySessionRouter {
  private readonly sessions = new Map<string, RoutedSession>()
  private readonly pendingSessions = new Map<string, Promise<RoutedSession>>()
  private readonly gcTimer: NodeJS.Timeout
  private readonly sessionIndex = new SessionIndexStore()

  constructor(
    private readonly logger: GatewayLogger,
    private readonly options: GatewaySessionRouterOptions,
  ) {
    this.gcTimer = setInterval(() => {
      void this.collectExpiredSessions()
    }, Math.max(10_000, Math.min(options.sessionIdleTimeoutMs || 60_000, 60_000)))
    this.gcTimer.unref?.()
  }

  async dispatch(
    event: GatewayInboundEvent,
    content: string,
    onUpdate?: (update: GatewayTurnUpdate) => void,
  ): Promise<GatewayTurnResult> {
    const key = this.buildSessionKey(event)
    const routed = await this.getOrCreateSession(key)

    const result = await routed.session.submit(content, onUpdate)
    await this.touchSessionIndex(routed)
    return result
  }

  async stop(): Promise<void> {
    clearInterval(this.gcTimer)
    await Promise.all(
      [...this.sessions.values()].map(async routed => {
        await this.touchSessionIndex(routed)
        await routed.session.close()
      }),
    )
    this.sessions.clear()
  }

  private buildSessionKey(event: GatewayInboundEvent): string {
    const parts: string[] = ['gateway', event.platform]
    switch (this.options.sessionKeyStrategy) {
      case 'user':
        parts.push(event.senderId)
        break
      case 'thread':
        parts.push(event.chatId, event.threadId || event.senderId)
        break
      case 'chat':
      default:
        parts.push(event.chatId)
        break
    }
    return parts.join(':')
  }

  private async getOrCreateSession(key: string): Promise<RoutedSession> {
    const existing = this.sessions.get(key)
    if (existing) {
      return existing
    }

    const pending = this.pendingSessions.get(key)
    if (pending) {
      return pending
    }

    const creation = this.createSession(key).finally(() => {
      this.pendingSessions.delete(key)
    })
    this.pendingSessions.set(key, creation)
    return creation
  }

  private async createSession(key: string): Promise<RoutedSession> {
    const existingEntry = await this.resolveExistingEntry(key)
    const session = new GatewaySession(this.logger, {
      workspace: existingEntry?.cwd ?? this.options.workspace,
      dangerouslySkipPermissions: this.options.dangerouslySkipPermissions,
      permissionMode: this.options.permissionMode,
      turnTimeoutMs: this.options.turnTimeoutMs,
      resumeSessionId: existingEntry?.transcriptSessionId,
    })
    const routed: RoutedSession = {
      key,
      session,
      createdAt: existingEntry?.createdAt ?? Date.now(),
    }
    try {
      await this.persistSessionIndex(routed)
    } catch (error) {
      await session.close().catch(() => {})
      throw error
    }
    this.sessions.set(key, routed)
    this.logger.info(`Created gateway session for ${key}`)
    return routed
  }

  private async collectExpiredSessions(): Promise<void> {
    if (this.options.sessionIdleTimeoutMs <= 0) {
      return
    }

    for (const [key, routed] of this.sessions) {
      if (routed.session.isBusy()) {
        continue
      }
      if (routed.session.idleForMs < this.options.sessionIdleTimeoutMs) {
        continue
      }
      this.sessions.delete(key)
      this.logger.info(`Closing idle gateway session for ${key}`)
      await this.touchSessionIndex(routed)
      await routed.session.close()
    }
  }

  private async resolveExistingEntry(
    sessionKey: string,
  ): Promise<SessionIndexEntry | undefined> {
    const entry = await this.sessionIndex.get(sessionKey)
    if (!entry) {
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

  private async persistSessionIndex(routed: RoutedSession): Promise<void> {
    await this.sessionIndex.set(routed.key, await this.buildSessionIndexEntry(routed))
  }

  private async touchSessionIndex(routed: RoutedSession): Promise<void> {
    await this.sessionIndex.touch(routed.key, {
      sessionId: await routed.session.getSessionId(),
      transcriptSessionId: await routed.session.getTranscriptSessionId(),
      cwd: await routed.session.getWorkDir(),
      permissionMode: this.options.permissionMode,
      lastActiveAt: Date.now(),
    })
  }

  private async buildSessionIndexEntry(
    routed: RoutedSession,
  ): Promise<SessionIndexEntry> {
    return {
      sessionId: await routed.session.getSessionId(),
      transcriptSessionId: await routed.session.getTranscriptSessionId(),
      cwd: await routed.session.getWorkDir(),
      permissionMode: this.options.permissionMode,
      createdAt: routed.createdAt,
      lastActiveAt: Date.now(),
    }
  }
}
