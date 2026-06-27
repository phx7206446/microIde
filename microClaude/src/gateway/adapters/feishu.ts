import { createHash, timingSafeEqual } from 'crypto'
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'http'
import * as Lark from '@larksuiteoapi/node-sdk'
import { errorMessage } from '../../utils/errors.js'
import { jsonParse, jsonStringify } from '../../utils/slowOperations.js'
import type { FeishuGatewayConfig } from '../config.js'
import type { GatewayLogger } from '../logger.js'
import type { GatewayInboundEvent, GatewayOutboundMessage } from '../types.js'
import {
  BaseGatewayAdapter,
  normalizeInboundText,
  splitTextForPlatform,
  truncateForLog,
} from './base.js'

const FEISHU_MAX_TEXT_LENGTH = 4000
const FEISHU_BODY_LIMIT_BYTES = 1024 * 1024
const FEISHU_BODY_TIMEOUT_MS = 15_000
const FEISHU_DEDUP_LIMIT = 2048
const FEISHU_API_TIMEOUT_MS = 30_000
const FEISHU_REPLY_FALLBACK_CODES = new Set([230011, 231003])

type FeishuMessageMention = {
  key?: string
  id?: {
    open_id?: string
    user_id?: string
    union_id?: string
  }
  name?: string
  tenant_key?: string
}

type FeishuSenderIdObject = {
  open_id?: string
  user_id?: string
  union_id?: string
}

type FeishuMessageEvent = {
  sender: {
    sender_id: FeishuSenderIdObject
  }
  message: {
    message_id: string
    root_id?: string
    thread_id?: string
    chat_id: string
    chat_type: 'p2p' | 'group' | 'private'
    message_type: string
    content: string
    mentions?: FeishuMessageMention[]
  }
}

type FeishuWebhookPayload = {
  schema?: string
  type?: string
  token?: string
  challenge?: string
  encrypt?: string
  header?: {
    event_id?: string
    event_type?: string
    token?: string
  }
  event?: unknown
}

type FeishuContentParseResult = {
  text: string
  mentionedOpenIds: string[]
}

type FeishuBotProfile = {
  openId?: string
  name?: string
}

type FeishuBotInfoResponse = {
  code?: number
  msg?: string
  bot?: {
    open_id?: string
    bot_name?: string
    name?: string
  }
  data?: {
    bot?: {
      open_id?: string
      bot_name?: string
      name?: string
    }
  }
}

type FeishuOpenApiResponse<T = unknown> = {
  code?: number
  msg?: string
  data?: T
}

type FeishuSendMessageData = {
  message_id?: string
}

type FeishuSenderProfileCacheEntry = {
  name: string
  expiresAt: number
}

type FeishuStreamState = {
  streamId: string
  chatId: string
  replyToMessageId?: string
  latestText: string
  flushedText: string
  latestSequence: number
  messageId?: string
  lastFlushAt: number
  timer?: NodeJS.Timeout
  flushPromise?: Promise<void>
  cardFailed: boolean
}

class FeishuApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: number,
    readonly raw?: string,
    readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'FeishuApiError'
  }
}

function getFeishuOpenApiBase(domain: 'feishu' | 'lark'): string {
  return domain === 'lark'
    ? 'https://open.larksuite.com'
    : 'https://open.feishu.cn'
}

function getFeishuSdkDomain(domain: 'feishu' | 'lark'): Lark.Domain {
  return domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function safeCompareString(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  if (leftBuffer.length !== rightBuffer.length) {
    return false
  }
  return timingSafeEqual(leftBuffer, rightBuffer)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed || undefined
}

function appendTextPart(parts: string[], value: unknown): void {
  const normalized = normalizeInboundText(typeof value === 'string' ? value : '')
  if (normalized) {
    parts.push(normalized)
  }
}

function collectPostText(
  value: unknown,
  state: { parts: string[]; mentionedOpenIds: Set<string> },
): void {
  if (typeof value === 'string') {
    appendTextPart(state.parts, value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectPostText(item, state)
    }
    return
  }
  if (!isRecord(value)) {
    return
  }

  const tag = readString(value.tag)?.toLowerCase()
  if (tag === 'at') {
    const mentionedOpenId = readString(value.open_id) ?? readString(value.user_id)
    if (mentionedOpenId) {
      state.mentionedOpenIds.add(mentionedOpenId)
    }
    appendTextPart(
      state.parts,
      readString(value.user_name) ??
        readString(value.name) ??
        (mentionedOpenId ? `@${mentionedOpenId}` : ''),
    )
    return
  }
  if (tag === 'img') {
    appendTextPart(state.parts, '[image]')
    return
  }
  if (tag === 'media') {
    appendTextPart(state.parts, '[media]')
    return
  }
  if (tag === 'emotion') {
    appendTextPart(
      state.parts,
      readString(value.emoji) ?? readString(value.text) ?? '[emotion]',
    )
    return
  }

  for (const [key, item] of Object.entries(value)) {
    if (key === 'image_key' || key === 'file_key' || key === 'style') {
      continue
    }
    collectPostText(item, state)
  }
}

function parsePostContent(rawContent: string): FeishuContentParseResult {
  try {
    const parsed = jsonParse(rawContent)
    const state = {
      parts: [] as string[],
      mentionedOpenIds: new Set<string>(),
    }
    collectPostText(parsed, state)
    return {
      text: state.parts.join('\n').trim() || '[Rich text message]',
      mentionedOpenIds: [...state.mentionedOpenIds],
    }
  } catch {
    return {
      text: '[Rich text message]',
      mentionedOpenIds: [],
    }
  }
}

function parseFeishuMessageText(
  messageType: string,
  rawContent: string | undefined,
): FeishuContentParseResult {
  let payload: Record<string, unknown> = {}
  if (rawContent) {
    try {
      const parsed = jsonParse(rawContent)
      if (isRecord(parsed)) {
        payload = parsed
      }
    } catch {
      return {
        text: normalizeInboundText(rawContent),
        mentionedOpenIds: [],
      }
    }
  }

  const normalize = (value: unknown): string =>
    normalizeInboundText(typeof value === 'string' ? value : '')

  switch (messageType) {
    case 'text':
      return {
        text: normalize(payload.text),
        mentionedOpenIds: [],
      }
    case 'post':
      return parsePostContent(rawContent ?? '')
    case 'image':
      return { text: '[image]', mentionedOpenIds: [] }
    case 'file':
      return {
        text: normalize(payload.file_name) || '[file]',
        mentionedOpenIds: [],
      }
    case 'audio':
      return { text: '[audio]', mentionedOpenIds: [] }
    case 'media':
      return {
        text: normalize(payload.file_name) || '[media]',
        mentionedOpenIds: [],
      }
    case 'sticker':
      return { text: '[sticker]', mentionedOpenIds: [] }
    case 'share_chat':
      return {
        text:
          normalize(payload.body) ||
          normalize(payload.summary) ||
          '[forwarded message]',
        mentionedOpenIds: [],
      }
    case 'merge_forward':
      return { text: '[merged forwarded message]', mentionedOpenIds: [] }
    default:
      return {
        text: normalize(rawContent ?? ''),
        mentionedOpenIds: [],
      }
  }
}

function resolveSenderId(senderId: FeishuSenderIdObject): string {
  return (
    readString(senderId.open_id) ??
    readString(senderId.user_id) ??
    readString(senderId.union_id) ??
    ''
  )
}

function checkBotMentioned(event: FeishuMessageEvent, botOpenId?: string): boolean {
  if ((event.message.content ?? '').includes('@_all')) {
    return true
  }

  const mentions = event.message.mentions ?? []
  if (mentions.length > 0) {
    if (!botOpenId) {
      return true
    }
    return mentions.some(mention => mention.id?.open_id === botOpenId)
  }

  if (event.message.message_type === 'post') {
    const parsed = parsePostContent(event.message.content)
    if (!botOpenId) {
      return parsed.mentionedOpenIds.length > 0
    }
    return parsed.mentionedOpenIds.includes(botOpenId)
  }

  return false
}

function parseFeishuMessageEventPayload(value: unknown): FeishuMessageEvent | null {
  if (!isRecord(value)) {
    return null
  }

  const sender = value.sender
  const message = value.message
  if (!isRecord(sender) || !isRecord(message)) {
    return null
  }

  const senderId = sender.sender_id
  if (!isRecord(senderId)) {
    return null
  }

  const messageId = readString(message.message_id)
  const chatId = readString(message.chat_id)
  const chatType = readString(message.chat_type)
  const messageType = readString(message.message_type)
  const content = readString(message.content)
  if (!messageId || !chatId || !chatType || !messageType || !content) {
    return null
  }

  return value as FeishuMessageEvent
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false

    const cleanup = () => {
      clearTimeout(timer)
      request.off('data', onData)
      request.off('end', onEnd)
      request.off('error', onError)
    }

    const finish = (fn: () => void) => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      fn()
    }

    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > FEISHU_BODY_LIMIT_BYTES) {
        finish(() => reject(new Error('Request body exceeds Feishu gateway limit')))
        request.destroy()
        return
      }
      chunks.push(buffer)
    }

    const onEnd = () => {
      finish(() => resolve(Buffer.concat(chunks)))
    }

    const onError = (error: Error) => {
      finish(() => reject(error))
    }

    const timer = setTimeout(() => {
      finish(() => reject(new Error('Feishu webhook body read timed out')))
      request.destroy()
    }, FEISHU_BODY_TIMEOUT_MS)

    request.on('data', onData)
    request.on('end', onEnd)
    request.on('error', onError)
  })
}

function sendJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
): void {
  response.statusCode = status
  response.setHeader('content-type', 'application/json')
  response.end(jsonStringify(payload))
}

function isFeishuWebhookPayload(value: unknown): value is FeishuWebhookPayload {
  return isRecord(value)
}

function parseFeishuWebhookPayload(rawBody: string): FeishuWebhookPayload | null {
  try {
    const parsed = jsonParse(rawBody)
    return isFeishuWebhookPayload(parsed) ? parsed : null
  } catch {
    return null
  }
}

function buildFeishuWebhookEnvelope(
  request: IncomingMessage,
  payload: FeishuWebhookPayload,
): Record<string, unknown> {
  return Object.assign(Object.create({ headers: request.headers }), payload)
}

function normalizeDispatcherWebhookPayload(
  payload: FeishuWebhookPayload,
): FeishuWebhookPayload {
  if (!payload.header?.event_type || payload.schema) {
    return payload
  }
  return {
    schema: '2.0',
    ...payload,
  }
}

function isFeishuWebhookSignatureValid(params: {
  headers: IncomingHttpHeaders
  rawBody: string
  encryptKey?: string
}): boolean {
  const encryptKey = params.encryptKey?.trim()
  if (!encryptKey) {
    return true
  }

  const timestampHeader = params.headers['x-lark-request-timestamp']
  const nonceHeader = params.headers['x-lark-request-nonce']
  const signatureHeader = params.headers['x-lark-signature']
  const timestamp = Array.isArray(timestampHeader) ? timestampHeader[0] : timestampHeader
  const nonce = Array.isArray(nonceHeader) ? nonceHeader[0] : nonceHeader
  const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader
  if (!timestamp || !nonce || !signature) {
    return false
  }

  const computedSignature = sha256Hex(
    `${timestamp}${nonce}${encryptKey}${params.rawBody}`,
  )
  return safeCompareString(computedSignature, signature)
}

function sleep(delayMs: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, delayMs))
}

function getRetryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after')
  if (!header) {
    return undefined
  }
  const seconds = Number.parseInt(header, 10)
  if (!Number.isFinite(seconds) || seconds < 0) {
    return undefined
  }
  return seconds * 1000
}

function inferFeishuSenderIdType(senderId: string): 'open_id' | 'union_id' | 'user_id' {
  if (senderId.startsWith('ou_')) {
    return 'open_id'
  }
  if (senderId.startsWith('on_')) {
    return 'union_id'
  }
  return 'user_id'
}

function isRetryableFeishuError(error: unknown): boolean {
  if (error instanceof FeishuApiError) {
    if (error.status === 429) {
      return true
    }
    if (typeof error.status === 'number' && error.status >= 500) {
      return true
    }
    return false
  }
  return error instanceof Error
}

function isReplyFallbackError(error: unknown): boolean {
  if (!(error instanceof FeishuApiError)) {
    return false
  }
  if (typeof error.code === 'number' && FEISHU_REPLY_FALLBACK_CODES.has(error.code)) {
    return true
  }
  const message = error.message.toLowerCase()
  return message.includes('withdrawn') || message.includes('not found')
}

function shouldRenderAsCard(mode: FeishuGatewayConfig['renderMode'], text: string): boolean {
  if (mode === 'card') {
    return true
  }
  if (mode === 'text') {
    return false
  }
  return (
    /```[\s\S]+?```/.test(text) ||
    /^\s*#{1,6}\s/m.test(text) ||
    /^\s*[-*]\s/m.test(text) ||
    /^\s*\d+\.\s/m.test(text) ||
    /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text) ||
    /\[[^\]]+\]\([^)]+\)/.test(text)
  )
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

function buildFeishuMarkdownCard(
  text: string,
  options?: {
    title?: string
    note?: string
  },
): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [
    {
      tag: 'markdown',
      content: text,
    },
  ]

  if (options?.note) {
    elements.push({ tag: 'hr' })
    elements.push({
      tag: 'markdown',
      content: `<font color='grey'>${options.note}</font>`,
    })
  }

  const card: Record<string, unknown> = {
    schema: '2.0',
    config: {
      width_mode: 'fill',
    },
    body: {
      elements,
    },
  }

  if (options?.title) {
    card.header = {
      title: {
        tag: 'plain_text',
        content: options.title,
      },
      template: 'blue',
    }
  }

  return card
}

export class FeishuGatewayAdapter extends BaseGatewayAdapter {
  readonly kind = 'feishu' as const

  private server?: HttpServer
  private wsClient?: Lark.WSClient
  private tenantAccessToken?: {
    value: string
    expiresAt: number
  }
  private readonly processedEventIds = new Map<string, number>()
  private readonly senderProfiles = new Map<string, FeishuSenderProfileCacheEntry>()
  private readonly streamingStates = new Map<string, FeishuStreamState>()
  private dispatcher?: Lark.EventDispatcher
  private botProfile: FeishuBotProfile = {}
  private stopped = false
  private outboundQueue: Promise<unknown> = Promise.resolve()
  private readonly inboundQueue: Array<() => Promise<void>> = []
  private readonly activeInboundTasks = new Set<Promise<void>>()
  private activeInboundCount = 0

  constructor(
    logger: GatewayLogger,
    private readonly config: FeishuGatewayConfig,
  ) {
    super(logger)
  }

  protected async startImpl(): Promise<void> {
    this.stopped = false
    this.dispatcher = this.createEventDispatcher()
    this.botProfile = await this.fetchBotProfile()

    if (this.config.connectionMode === 'webhook') {
      await this.startWebhookServer()
      return
    }

    await this.startWebSocketClient()
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const state of this.streamingStates.values()) {
      if (state.timer) {
        clearTimeout(state.timer)
      }
    }
    this.streamingStates.clear()
    this.inboundQueue.length = 0

    const server = this.server
    const wsClient = this.wsClient
    this.server = undefined
    this.wsClient = undefined

    await Promise.allSettled([...this.activeInboundTasks])
    await this.outboundQueue.catch(() => undefined)

    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close(error => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      })
    }

    wsClient?.close()
  }

  async send(message: GatewayOutboundMessage): Promise<void> {
    const state = message.streamId ? this.streamingStates.get(message.streamId) : undefined
    if (state?.timer) {
      clearTimeout(state.timer)
      state.timer = undefined
    }

    await this.enqueueOutbound(() => this.sendImpl(message))
  }

  async sendStreamingUpdate(message: GatewayOutboundMessage): Promise<void> {
    if (
      !message.streamId ||
      !this.config.streaming ||
      this.config.renderMode === 'text' ||
      this.stopped
    ) {
      return
    }

    const state = this.getOrCreateStreamState(message)
    if (typeof message.sequence === 'number' && message.sequence <= state.latestSequence) {
      return
    }

    state.latestSequence = message.sequence ?? state.latestSequence + 1
    state.latestText = mergeStreamingText(state.latestText, message.text)
    if (!state.latestText || state.latestText === state.flushedText || state.cardFailed) {
      return
    }

    this.scheduleStreamingFlush(state)
  }

  private createEventDispatcher(): Lark.EventDispatcher {
    return new Lark.EventDispatcher({
      encryptKey: this.config.encryptKey,
      verificationToken: this.config.verificationToken,
      loggerLevel: Lark.LoggerLevel.warn,
    }).register({
      'im.message.receive_v1': async (data: unknown) => {
        this.handleInboundPayload(data)
        return { code: 0 }
      },
    })
  }

  private async startWebSocketClient(): Promise<void> {
    const wsClient = new Lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      domain: getFeishuSdkDomain(this.config.domain),
      loggerLevel: Lark.LoggerLevel.info,
    })

    this.wsClient = wsClient
    await wsClient.start({
      eventDispatcher: this.dispatcher!,
    })

    this.logger.info(
      `Feishu gateway connected via persistent WebSocket${this.botProfile.openId ? ` (bot=${this.botProfile.openId})` : ''}`,
    )
  }

  private async startWebhookServer(): Promise<void> {
    this.server = createServer((request, response) => {
      void this.handleWebhookRequest(request, response)
    })

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(
        this.config.webhookPort,
        this.config.webhookHost,
        () => resolve(),
      )
    })

    this.logger.info(
      `Feishu gateway listening on http://${this.config.webhookHost}:${this.config.webhookPort}${this.config.webhookPath}`,
    )
  }

  private async handleWebhookRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      if (request.method !== 'POST' || request.url !== this.config.webhookPath) {
        sendJson(response, 404, { ok: false })
        return
      }

      const body = await readRequestBody(request)
      const rawBody = body.toString('utf8')

      if (
        !isFeishuWebhookSignatureValid({
          headers: request.headers,
          rawBody,
          encryptKey: this.config.encryptKey,
        })
      ) {
        sendJson(response, 401, { code: 401, msg: 'invalid signature' })
        return
      }

      const payload = parseFeishuWebhookPayload(rawBody)
      if (!payload) {
        sendJson(response, 400, { code: 400, msg: 'invalid json' })
        return
      }

      if (!this.isWebhookTokenValid(payload)) {
        sendJson(response, 401, { code: 401, msg: 'invalid token' })
        return
      }

      const { isChallenge, challenge } = Lark.generateChallenge(payload, {
        encryptKey: this.config.encryptKey ?? '',
      })
      if (isChallenge) {
        sendJson(response, 200, challenge)
        return
      }

      const visibleEventType = payload.header?.event_type
      if (visibleEventType && visibleEventType !== 'im.message.receive_v1') {
        sendJson(response, 200, { code: 0 })
        return
      }

      const value = await this.dispatcher!.invoke(
        buildFeishuWebhookEnvelope(
          request,
          normalizeDispatcherWebhookPayload(payload),
        ),
        {
          needCheck: false,
        },
      )
      sendJson(response, 200, value ?? { code: 0 })
    } catch (error) {
      this.logger.error('Feishu webhook request failed', error)
      sendJson(response, 500, { code: 500, msg: errorMessage(error) })
    }
  }

  private isWebhookTokenValid(payload: FeishuWebhookPayload): boolean {
    if (!this.config.verificationToken) {
      return true
    }

    const token = payload.token ?? payload.header?.token ?? ''
    if (!token) {
      return true
    }

    return safeCompareString(token, this.config.verificationToken)
  }

  private handleInboundPayload(payload: unknown): void {
    const event = parseFeishuMessageEventPayload(payload)
    if (!event) {
      this.logger.warn('Ignoring malformed Feishu message event payload')
      return
    }

    const eventId =
      readString(event.message.message_id) ??
      readString((event as Record<string, unknown>).event_id) ??
      ''
    if (!eventId || this.hasSeenEvent(eventId)) {
      return
    }

    this.enqueueInbound(async () => {
      const inboundEvent = await this.buildInboundEvent(event, eventId)
      if (!inboundEvent) {
        return
      }

      this.logger.info(
        `Feishu inbound ${inboundEvent.senderId} -> ${inboundEvent.chatId}: ${truncateForLog(inboundEvent.text)}`,
      )

      await this.emit(inboundEvent)
    })
  }

  private enqueueInbound(task: () => Promise<void>): void {
    if (this.stopped) {
      return
    }

    if (
      this.inboundQueue.length + this.activeInboundCount >=
      this.config.maxQueuedDispatches
    ) {
      this.logger.warn('Feishu inbound queue is full; dropping event')
      return
    }

    this.inboundQueue.push(task)
    this.drainInboundQueue()
  }

  private drainInboundQueue(): void {
    while (
      !this.stopped &&
      this.activeInboundCount < this.config.maxConcurrentDispatches &&
      this.inboundQueue.length > 0
    ) {
      const task = this.inboundQueue.shift()!
      this.activeInboundCount += 1
      const running = task()
        .catch(error => {
          this.logger.error('Feishu inbound turn failed', error)
        })
        .finally(() => {
          this.activeInboundCount = Math.max(0, this.activeInboundCount - 1)
          this.activeInboundTasks.delete(running)
          this.drainInboundQueue()
        })
      this.activeInboundTasks.add(running)
    }
  }

  private async buildInboundEvent(
    event: FeishuMessageEvent,
    eventId: string,
  ): Promise<GatewayInboundEvent | null> {
    const message = event.message
    const senderId = resolveSenderId(event.sender.sender_id)
    const chatId = readString(message.chat_id) ?? ''
    if (!senderId || !chatId) {
      return null
    }

    const content = parseFeishuMessageText(
      message.message_type ?? '',
      message.content,
    )
    if (!content.text) {
      return null
    }

    const isDirectMessage = message.chat_type === 'p2p'
    const mentionsSelf = !isDirectMessage
      ? checkBotMentioned(event, this.botProfile.openId)
      : false

    return {
      platform: 'feishu',
      eventId,
      senderId,
      senderName: await this.resolveSenderName(event.sender.sender_id),
      chatId,
      chatType: isDirectMessage ? 'dm' : 'group',
      threadId: readString(message.root_id) ?? readString(message.thread_id),
      text: content.text,
      mentionsSelf,
      replyToMessageId: this.config.replyToMessage
        ? readString(message.message_id)
        : undefined,
      metadata: {
        message_id: readString(message.message_id) ?? '',
        chat_type: readString(message.chat_type) ?? '',
        message_type: readString(message.message_type) ?? '',
      },
    }
  }

  private hasSeenEvent(eventId: string): boolean {
    if (this.processedEventIds.has(eventId)) {
      return true
    }
    this.processedEventIds.set(eventId, Date.now())
    if (this.processedEventIds.size > FEISHU_DEDUP_LIMIT) {
      const oldest = this.processedEventIds.keys().next().value
      if (oldest !== undefined) {
        this.processedEventIds.delete(oldest)
      }
    }
    return false
  }

  private getOrCreateStreamState(message: GatewayOutboundMessage): FeishuStreamState {
    const existing = this.streamingStates.get(message.streamId!)
    if (existing) {
      return existing
    }

    const state: FeishuStreamState = {
      streamId: message.streamId!,
      chatId: message.chatId,
      replyToMessageId: message.replyToMessageId,
      latestText: '',
      flushedText: '',
      latestSequence: 0,
      lastFlushAt: 0,
      cardFailed: false,
    }
    this.streamingStates.set(state.streamId, state)
    return state
  }

  private scheduleStreamingFlush(state: FeishuStreamState): void {
    const elapsed = Date.now() - state.lastFlushAt
    const delayMs = Math.max(0, this.config.streamUpdateThrottleMs - elapsed)

    if (delayMs === 0) {
      this.enqueueStreamingFlush(state)
      return
    }
    if (state.timer) {
      return
    }

    state.timer = setTimeout(() => {
      state.timer = undefined
      this.enqueueStreamingFlush(state)
    }, delayMs)
    state.timer.unref?.()
  }

  private enqueueStreamingFlush(state: FeishuStreamState): void {
    if (this.stopped || state.cardFailed || !state.latestText) {
      return
    }

    const promise = this.enqueueOutbound(() => this.flushStreamingState(state, false))
    state.flushPromise = promise.finally(() => {
      if (state.flushPromise === promise) {
        state.flushPromise = undefined
      }
    })
  }

  private async sendImpl(message: GatewayOutboundMessage): Promise<void> {
    const state = message.streamId ? this.streamingStates.get(message.streamId) : undefined

    if (state && message.phase === 'final') {
      state.latestText = mergeStreamingText(state.latestText, message.text)
      await state.flushPromise?.catch(() => undefined)

      if (!state.cardFailed) {
        await this.flushStreamingState(state, true)
        this.disposeStreamingState(state.streamId)
        return
      }

      this.disposeStreamingState(state.streamId)
      await this.sendFinalMessage(message, true)
      return
    }

    await this.sendFinalMessage(message, false)
  }

  private async sendFinalMessage(
    message: GatewayOutboundMessage,
    forceText: boolean,
  ): Promise<void> {
    const useCard = !forceText && shouldRenderAsCard(this.config.renderMode, message.text)
    const chunks = splitTextForPlatform(message.text, FEISHU_MAX_TEXT_LENGTH)
    for (const chunk of chunks) {
      if (useCard) {
        await this.sendCardChunk(chunk, message.chatId, message.replyToMessageId)
      } else {
        await this.sendTextChunk(chunk, message.chatId, message.replyToMessageId)
      }
    }
  }

  private async flushStreamingState(
    state: FeishuStreamState,
    final: boolean,
  ): Promise<void> {
    if (state.cardFailed || !state.latestText) {
      return
    }
    if (!final && state.latestText === state.flushedText) {
      return
    }

    const content = jsonStringify(
      buildFeishuMarkdownCard(state.latestText, {
        title: this.botProfile.name ?? 'Claude',
        note: final ? undefined : 'Generating...',
      }),
    )

    try {
      if (!state.messageId) {
        state.messageId = await this.createMessage(
          state.chatId,
          'interactive',
          content,
          state.replyToMessageId,
        )
      } else {
        await this.patchMessage(state.messageId, content)
      }
      state.flushedText = state.latestText
      state.lastFlushAt = Date.now()
    } catch (error) {
      state.cardFailed = true
      this.logger.warn(`Feishu streaming card update failed: ${errorMessage(error)}`)
    }
  }

  private disposeStreamingState(streamId: string): void {
    const state = this.streamingStates.get(streamId)
    if (!state) {
      return
    }
    if (state.timer) {
      clearTimeout(state.timer)
    }
    this.streamingStates.delete(streamId)
  }

  private enqueueOutbound<T>(task: () => Promise<T>): Promise<T> {
    const queued = this.outboundQueue.then(task, task)
    this.outboundQueue = queued.catch(() => undefined)
    return queued
  }

  private async sendTextChunk(
    text: string,
    chatId: string,
    replyToMessageId?: string,
  ): Promise<void> {
    await this.createMessage(
      chatId,
      'text',
      jsonStringify({ text }),
      replyToMessageId,
    )
  }

  private async sendCardChunk(
    text: string,
    chatId: string,
    replyToMessageId?: string,
  ): Promise<void> {
    const content = jsonStringify(
      buildFeishuMarkdownCard(text, {
        title: this.botProfile.name ?? 'Claude',
      }),
    )

    try {
      await this.createMessage(chatId, 'interactive', content, replyToMessageId)
    } catch (error) {
      this.logger.warn(`Feishu card send failed, falling back to text: ${errorMessage(error)}`)
      await this.sendTextChunk(text, chatId, replyToMessageId)
    }
  }

  private async createMessage(
    chatId: string,
    msgType: 'text' | 'interactive',
    content: string,
    replyToMessageId?: string,
  ): Promise<string> {
    if (replyToMessageId) {
      try {
        const response = await this.apiJson<FeishuSendMessageData>({
          method: 'POST',
          path: `/open-apis/im/v1/messages/${encodeURIComponent(replyToMessageId)}/reply`,
          body: {
            msg_type: msgType,
            content,
          },
          label: 'send reply',
        })
        const messageId = readString(response.data?.message_id)
        if (!messageId) {
          throw new Error('Feishu reply did not return a message_id')
        }
        return messageId
      } catch (error) {
        if (!isReplyFallbackError(error)) {
          throw error
        }
      }
    }

    const response = await this.apiJson<FeishuSendMessageData>({
      method: 'POST',
      path: '/open-apis/im/v1/messages?receive_id_type=chat_id',
      body: {
        receive_id: chatId,
        msg_type: msgType,
        content,
      },
      label: 'send message',
    })
    const messageId = readString(response.data?.message_id)
    if (!messageId) {
      throw new Error('Feishu message send did not return a message_id')
    }
    return messageId
  }

  private async patchMessage(messageId: string, content: string): Promise<void> {
    await this.apiJson({
      method: 'PATCH',
      path: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
      body: {
        content,
      },
      label: 'patch message',
    })
  }

  private async resolveSenderName(
    senderIds: FeishuSenderIdObject,
  ): Promise<string | undefined> {
    const candidates = [
      readString(senderIds.open_id),
      readString(senderIds.user_id),
      readString(senderIds.union_id),
    ].filter((value): value is string => Boolean(value))

    for (const senderId of candidates) {
      const cached = this.senderProfiles.get(senderId)
      if (cached && cached.expiresAt > Date.now()) {
        return cached.name
      }

      try {
        const response = await this.apiJson<{
          user?: {
            name?: string
            display_name?: string
            nickname?: string
            en_name?: string
          }
        }>({
          method: 'GET',
          path: `/open-apis/contact/v3/users/${encodeURIComponent(senderId)}?user_id_type=${inferFeishuSenderIdType(senderId)}`,
          label: 'fetch sender profile',
        })

        const user = response.data?.user
        const name =
          readString(user?.name) ??
          readString(user?.display_name) ??
          readString(user?.nickname) ??
          readString(user?.en_name)
        if (!name) {
          continue
        }

        this.senderProfiles.set(senderId, {
          name,
          expiresAt: Date.now() + this.config.senderProfileTtlMs,
        })
        return name
      } catch (error) {
        this.logger.warn(
          `Failed to resolve Feishu sender name for ${senderId}: ${errorMessage(error)}`,
        )
      }
    }

    return undefined
  }

  private async fetchBotProfile(): Promise<FeishuBotProfile> {
    try {
      const response = await this.apiJson<FeishuBotInfoResponse['data']>({
        method: 'GET',
        path: '/open-apis/bot/v3/info',
        label: 'fetch bot profile',
      })
      const parsed = response as FeishuBotInfoResponse
      const bot = parsed.bot ?? parsed.data?.bot
      const profile = {
        openId: readString(bot?.open_id),
        name: readString(bot?.bot_name) ?? readString(bot?.name),
      }

      if (profile.openId) {
        this.logger.info(
          `Feishu bot profile resolved: ${profile.name ? `${profile.name} ` : ''}${profile.openId}`,
        )
      }

      return profile
    } catch (error) {
      this.logger.warn(`Failed to resolve Feishu bot profile: ${errorMessage(error)}`)
      return {}
    }
  }

  private async apiJson<T = unknown>(params: {
    method: 'GET' | 'POST' | 'PATCH'
    path: string
    body?: unknown
    auth?: 'tenant' | 'none'
    label: string
  }): Promise<FeishuOpenApiResponse<T>> {
    let lastError: unknown

    for (let attempt = 1; attempt <= this.config.maxSendRetries; attempt += 1) {
      try {
        const headers: Record<string, string> = {
          'content-type': 'application/json; charset=utf-8',
        }

        if (params.auth !== 'none') {
          headers.authorization = `Bearer ${await this.getTenantAccessToken()}`
        }

        const response = await fetch(
          `${getFeishuOpenApiBase(this.config.domain)}${params.path}`,
          {
            method: params.method,
            headers,
            body: params.body === undefined ? undefined : jsonStringify(params.body),
            signal: AbortSignal.timeout(FEISHU_API_TIMEOUT_MS),
          },
        )

        const raw = await response.text()
        let parsed: FeishuOpenApiResponse<T> = {}
        if (raw.trim()) {
          parsed = jsonParse(raw) as FeishuOpenApiResponse<T>
        }

        if (!response.ok) {
          throw new FeishuApiError(
            `${params.label} failed: ${response.status} ${raw}`.trim(),
            response.status,
            parsed.code,
            raw,
            getRetryAfterMs(response),
          )
        }

        if (parsed.code !== undefined && parsed.code !== 0) {
          throw new FeishuApiError(
            `${params.label} failed: ${parsed.code} ${parsed.msg ?? ''}`.trim(),
            response.status,
            parsed.code,
            raw,
            getRetryAfterMs(response),
          )
        }

        return parsed
      } catch (error) {
        lastError = error
        if (
          params.auth !== 'none' &&
          error instanceof FeishuApiError &&
          (error.status === 401 || error.status === 403)
        ) {
          this.tenantAccessToken = undefined
        }

        if (attempt >= this.config.maxSendRetries || !isRetryableFeishuError(error)) {
          throw error
        }

        const retryAfterMs =
          error instanceof FeishuApiError ? error.retryAfterMs : undefined
        const baseDelayMs =
          retryAfterMs ??
          this.config.sendRetryBaseDelayMs * 2 ** (attempt - 1)
        const jitterMs = Math.floor(Math.random() * Math.max(baseDelayMs / 4, 1))
        await sleep(baseDelayMs + jitterMs)
      }
    }

    throw lastError
  }

  private async getTenantAccessToken(): Promise<string> {
    const cached = this.tenantAccessToken
    if (cached && cached.expiresAt > Date.now() + 60_000) {
      return cached.value
    }

    const response = await this.apiJson({
      method: 'POST',
      path: '/open-apis/auth/v3/tenant_access_token/internal',
      body: {
        app_id: this.config.appId,
        app_secret: this.config.appSecret,
      },
      auth: 'none',
      label: 'feishu auth',
    })

    const parsed = response as {
      tenant_access_token?: string
      expire?: number
    }
    if (!parsed.tenant_access_token) {
      throw new Error('Feishu auth did not return tenant_access_token')
    }

    this.tenantAccessToken = {
      value: parsed.tenant_access_token,
      expiresAt: Date.now() + Math.max((parsed.expire ?? 7200) - 60, 60) * 1000,
    }
    return parsed.tenant_access_token
  }
}
