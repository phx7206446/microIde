import { randomBytes, randomUUID } from 'crypto'
import type { GatewayLogger } from '../logger.js'
import { errorMessage } from '../../utils/errors.js'
import { jsonParse, jsonStringify } from '../../utils/slowOperations.js'
import type { WeixinGatewayConfig } from '../config.js'
import type { GatewayOutboundMessage } from '../types.js'
import {
  BaseGatewayAdapter,
  normalizeInboundText,
  splitTextForPlatform,
  truncateForLog,
} from './base.js'

const WEIXIN_APP_ID = 'bot'
const WEIXIN_CHANNEL_VERSION = '2.2.0'
const WEIXIN_APP_CLIENT_VERSION = (2 << 16) | (2 << 8) | 0
const WEIXIN_MESSAGE_TYPE_BOT = 2
const WEIXIN_MESSAGE_STATE_FINISH = 2
const WEIXIN_ITEM_TEXT = 1
const WEIXIN_ITEM_IMAGE = 2
const WEIXIN_ITEM_VOICE = 3
const WEIXIN_ITEM_FILE = 4
const WEIXIN_ITEM_VIDEO = 5
const WEIXIN_MAX_TEXT_LENGTH = 3600
const WEIXIN_DEDUP_LIMIT = 2048

type WeixinMessageItem = {
  type?: number
  text_item?: {
    text?: string
  }
}

type WeixinInboundMessage = {
  msg_type?: number
  from_user_id?: string
  from_user_name?: string
  room_id?: string
  chat_room_id?: string
  server_id?: string
  msg_id?: string
  client_id?: string
  context_token?: string
  item_list?: WeixinMessageItem[]
}

function randomWechatUin(): string {
  const value = randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(value), 'utf8').toString('base64')
}

function extractWeixinText(items: WeixinMessageItem[] | undefined): string {
  const parts: string[] = []
  for (const item of items ?? []) {
    switch (item.type) {
      case WEIXIN_ITEM_TEXT:
        if (item.text_item?.text) {
          parts.push(normalizeInboundText(item.text_item.text))
        }
        break
      case WEIXIN_ITEM_IMAGE:
        parts.push('[image]')
        break
      case WEIXIN_ITEM_VOICE:
        parts.push('[voice]')
        break
      case WEIXIN_ITEM_FILE:
        parts.push('[file]')
        break
      case WEIXIN_ITEM_VIDEO:
        parts.push('[video]')
        break
      default:
        break
    }
  }
  return parts.filter(Boolean).join('\n')
}

export class WeixinGatewayAdapter extends BaseGatewayAdapter {
  readonly kind = 'weixin' as const

  private running = false
  private loop?: Promise<void>
  private syncBuffer = ''
  private readonly contextTokens = new Map<string, string>()
  private readonly processedEventIds = new Map<string, number>()

  constructor(
    logger: GatewayLogger,
    private readonly config: WeixinGatewayConfig,
  ) {
    super(logger)
  }

  protected async startImpl(): Promise<void> {
    this.running = true
    this.loop = this.pollLoop()
    this.logger.info(`Weixin gateway polling ${this.config.baseUrl}`)
  }

  async stop(): Promise<void> {
    this.running = false
    await this.loop?.catch(() => {})
  }

  async send(message: GatewayOutboundMessage): Promise<void> {
    const chunks = splitTextForPlatform(message.text, WEIXIN_MAX_TEXT_LENGTH)
    for (const chunk of chunks) {
      await this.sendChunk(message.chatId, chunk)
    }
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const result = await this.apiPost(
          'ilink/bot/getupdates',
          {
            get_updates_buf: this.syncBuffer,
          },
          this.config.pollTimeoutMs + 5_000,
        )
        if (typeof result.get_updates_buf === 'string') {
          this.syncBuffer = result.get_updates_buf
        }
        const messages = Array.isArray(result.msgs) ? result.msgs : []
        for (const raw of messages) {
          await this.handleInboundMessage(raw as WeixinInboundMessage)
        }
      } catch (error) {
        this.logger.warn(`Weixin polling failed: ${errorMessage(error)}`)
        await new Promise(resolve => setTimeout(resolve, 2_000))
      }
    }
  }

  private async handleInboundMessage(message: WeixinInboundMessage): Promise<void> {
    const senderId = String(message.from_user_id ?? '').trim()
    if (!senderId) {
      return
    }

    const chatId = String(
      message.room_id ?? message.chat_room_id ?? message.from_user_id ?? '',
    ).trim()
    if (!chatId) {
      return
    }

    const eventId = String(
      message.server_id ?? message.msg_id ?? message.client_id ?? '',
    ).trim()
    if (eventId && this.hasSeenEvent(eventId)) {
      return
    }

    const text = extractWeixinText(message.item_list)
    if (!text) {
      return
    }

    if (typeof message.context_token === 'string' && message.context_token.trim()) {
      this.contextTokens.set(chatId, message.context_token.trim())
    }

    await this.emit({
      platform: 'weixin',
      eventId: eventId || randomUUID(),
      senderId,
      senderName: String(message.from_user_name ?? '').trim() || undefined,
      chatId,
      chatType:
        message.room_id || message.chat_room_id ? 'group' : 'dm',
      text,
      mentionsSelf: false,
      metadata: {
        server_id: String(message.server_id ?? ''),
      },
    })
    this.logger.info(
      `Weixin inbound ${senderId} -> ${chatId}: ${truncateForLog(text)}`,
    )
  }

  private hasSeenEvent(eventId: string): boolean {
    if (this.processedEventIds.has(eventId)) {
      return true
    }
    this.processedEventIds.set(eventId, Date.now())
    if (this.processedEventIds.size > WEIXIN_DEDUP_LIMIT) {
      const oldest = this.processedEventIds.keys().next().value
      if (oldest !== undefined) {
        this.processedEventIds.delete(oldest)
      }
    }
    return false
  }

  private async sendChunk(chatId: string, text: string): Promise<void> {
    const contextToken = this.contextTokens.get(chatId)
    await this.apiPost(
      'ilink/bot/sendmessage',
      {
        msg: {
          from_user_id: '',
          to_user_id: chatId,
          client_id: randomUUID(),
          message_type: WEIXIN_MESSAGE_TYPE_BOT,
          message_state: WEIXIN_MESSAGE_STATE_FINISH,
          ...(contextToken ? { context_token: contextToken } : {}),
          item_list: [
            {
              type: WEIXIN_ITEM_TEXT,
              text_item: {
                text,
              },
            },
          ],
        },
      },
      30_000,
    )
  }

  private async apiPost(
    endpoint: string,
    payload: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const body = jsonStringify({
      ...payload,
      base_info: {
        channel_version: WEIXIN_CHANNEL_VERSION,
      },
    })
    const response = await fetch(
      `${this.config.baseUrl.replace(/\/$/, '')}/${endpoint}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.token}`,
          AuthorizationType: 'ilink_bot_token',
          'X-WECHAT-UIN': randomWechatUin(),
          'iLink-App-Id': WEIXIN_APP_ID,
          'iLink-App-ClientVersion': String(WEIXIN_APP_CLIENT_VERSION),
          ...(this.config.routeTag !== undefined
            ? { SKRouteTag: String(this.config.routeTag) }
            : {}),
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      },
    )
    const raw = await response.text()
    if (!response.ok) {
      throw new Error(`Weixin API ${endpoint} failed: ${response.status} ${raw}`)
    }
    const parsed = jsonParse(raw) as Record<string, unknown>
    const ret = typeof parsed.ret === 'number' ? parsed.ret : 0
    if (ret !== 0) {
      throw new Error(
        `Weixin API ${endpoint} returned ret=${ret}: ${String(parsed.err_msg ?? parsed.errmsg ?? '')}`,
      )
    }
    return parsed
  }
}
