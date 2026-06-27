import { randomUUID } from 'crypto'
import { wrapChannelMessage } from '../services/mcp/channelNotification.js'
import type {
  FeishuGatewayConfig,
  GatewayConfig,
  GatewayPlatformConfig,
  WeixinGatewayConfig,
} from './config.js'
import type { GatewayLogger } from './logger.js'
import { GatewayPairingStore } from './pairing.js'
import { authorizeGatewayEvent } from './policy.js'
import { GatewaySessionRouter } from './router.js'
import type {
  GatewayInboundEvent,
  GatewayOutboundMessage,
  GatewayPlatform,
} from './types.js'
import type { GatewayAdapter } from './adapters/base.js'
import { FeishuGatewayAdapter } from './adapters/feishu.js'
import { WeixinGatewayAdapter } from './adapters/weixin.js'

export class GatewayRuntime {
  private readonly adapters = new Map<GatewayPlatform, GatewayAdapter>()
  private readonly platformConfigs = new Map<GatewayPlatform, GatewayPlatformConfig>()
  private readonly pairingStore = new GatewayPairingStore()
  private readonly router: GatewaySessionRouter

  constructor(
    private readonly config: GatewayConfig,
    private readonly logger: GatewayLogger,
  ) {
    this.router = new GatewaySessionRouter(logger, {
      workspace: config.workspace,
      dangerouslySkipPermissions: config.dangerouslySkipPermissions,
      permissionMode: config.permissionMode,
      turnTimeoutMs: config.turnTimeoutMs,
      sessionIdleTimeoutMs: config.sessionIdleTimeoutMs,
      sessionKeyStrategy: config.sessionKeyStrategy,
    })
  }

  async start(selectedPlatforms?: readonly GatewayPlatform[]): Promise<void> {
    const wanted = new Set(selectedPlatforms ?? [])
    const platformConfigs = this.config.platforms.filter(
      platform => platform.enabled && (wanted.size === 0 || wanted.has(platform.kind)),
    )
    if (platformConfigs.length === 0) {
      throw new Error('No enabled gateway platforms matched the current selection')
    }

    for (const platform of platformConfigs) {
      this.platformConfigs.set(platform.kind, platform)
      const adapter = this.createAdapter(platform)
      this.adapters.set(platform.kind, adapter)
      await adapter.start(async event => {
        await this.handleEvent(event)
      })
    }
  }

  async stop(): Promise<void> {
    await Promise.all(
      [...this.adapters.values()].map(adapter =>
        adapter.stop().catch(error => {
          this.logger.error(`Failed to stop ${adapter.kind} adapter`, error)
        }),
      ),
    )
    this.adapters.clear()
    this.platformConfigs.clear()
    await this.router.stop()
  }

  getRunningPlatforms(): GatewayPlatform[] {
    return [...this.adapters.keys()]
  }

  private createAdapter(platform: GatewayPlatformConfig): GatewayAdapter {
    switch (platform.kind) {
      case 'feishu':
        return new FeishuGatewayAdapter(
          this.logger,
          platform as FeishuGatewayConfig,
        )
      case 'weixin':
        return new WeixinGatewayAdapter(
          this.logger,
          platform as WeixinGatewayConfig,
        )
      default:
        throw new Error(
          `Unsupported gateway platform: ${(platform as { kind: string }).kind}`,
        )
    }
  }

  private async handleEvent(event: GatewayInboundEvent): Promise<void> {
    const adapter = this.adapters.get(event.platform)
    if (!adapter) {
      this.logger.warn(`No running adapter found for ${event.platform}`)
      return
    }
    const platformConfig = this.platformConfigs.get(event.platform)
    if (!platformConfig) {
      this.logger.warn(`No gateway config found for ${event.platform}`)
      return
    }

    const authorization = await authorizeGatewayEvent(
      platformConfig,
      event,
      this.pairingStore,
    )
    if (authorization.kind === 'ignore') {
      this.logger.info(
        `Gateway ignored ${event.platform}:${event.chatId} (${authorization.reason})`,
      )
      return
    }
    if (authorization.kind === 'reply') {
      await adapter.send({
        platform: event.platform,
        chatId: event.chatId,
        threadId: event.threadId,
        text: authorization.message,
        replyToMessageId: event.replyToMessageId,
      })
      return
    }

    const sessionInput = this.buildSessionInput(event)
    const streamId = randomUUID()
    try {
      const result = await this.router.dispatch(event, sessionInput, update => {
        if (!adapter.sendStreamingUpdate || !update.text.trim()) {
          return
        }

        void adapter
          .sendStreamingUpdate({
            platform: event.platform,
            chatId: event.chatId,
            threadId: event.threadId,
            text: update.text,
            replyToMessageId: event.replyToMessageId,
            streamId,
            phase: 'partial',
            sequence: update.sequence,
          })
          .catch(error => {
            this.logger.warn(
              `Gateway streaming update failed for ${event.platform}:${event.chatId}: ${error instanceof Error ? error.message : String(error)}`,
            )
          })
      })
      const outboundText = result.message.trim()
      if (!outboundText) {
        return
      }
      const outbound: GatewayOutboundMessage = {
        platform: event.platform,
        chatId: event.chatId,
        threadId: event.threadId,
        text: outboundText,
        replyToMessageId: event.replyToMessageId,
        streamId,
        phase: 'final',
      }
      await adapter.send(outbound)
    } catch (error) {
      this.logger.error(
        `Gateway turn failed for ${event.platform}:${event.chatId}`,
        error,
      )
    }
  }

  private buildSessionInput(event: GatewayInboundEvent): string {
    if (this.config.sessionMode === 'channel') {
      const meta: Record<string, string> = {
        chat_id: event.chatId,
        user: event.senderId,
      }
      if (event.threadId) {
        meta.thread_id = event.threadId
      }
      if (event.chatType) {
        meta.chat_type = event.chatType
      }
      if (event.senderName) {
        meta.sender_name = event.senderName
      }
      if (event.chatName) {
        meta.chat_name = event.chatName
      }
      return wrapChannelMessage(event.platform, event.text, meta)
    }
    return event.text
  }
}
