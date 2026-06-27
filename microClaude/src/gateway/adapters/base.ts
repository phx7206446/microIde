import type { GatewayLogger } from '../logger.js'
import type {
  GatewayInboundEvent,
  GatewayOutboundMessage,
  GatewayPlatform,
} from '../types.js'

export type GatewayEventHandler = (event: GatewayInboundEvent) => Promise<void>

export interface GatewayAdapter {
  readonly kind: GatewayPlatform
  start(onEvent: GatewayEventHandler): Promise<void>
  stop(): Promise<void>
  send(message: GatewayOutboundMessage): Promise<void>
  sendStreamingUpdate?(message: GatewayOutboundMessage): Promise<void>
}

export function normalizeInboundText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
}

export function truncateForLog(text: string, maxLength = 120): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, Math.max(0, maxLength - 3))}...`
}

export function splitTextForPlatform(
  text: string,
  maxLength: number,
): string[] {
  if (text.length <= maxLength) {
    return [text]
  }

  const chunks: string[] = []
  let remaining = text
  while (remaining.length > maxLength) {
    let cut = remaining.lastIndexOf('\n', maxLength)
    if (cut < Math.floor(maxLength / 2)) {
      cut = remaining.lastIndexOf(' ', maxLength)
    }
    if (cut < Math.floor(maxLength / 2)) {
      cut = maxLength
    }
    chunks.push(remaining.slice(0, cut).trim())
    remaining = remaining.slice(cut).trimStart()
  }
  if (remaining.length > 0) {
    chunks.push(remaining)
  }
  return chunks.filter(Boolean)
}

export abstract class BaseGatewayAdapter implements GatewayAdapter {
  abstract readonly kind: GatewayPlatform
  protected onEvent?: GatewayEventHandler

  constructor(protected readonly logger: GatewayLogger) {}

  async start(onEvent: GatewayEventHandler): Promise<void> {
    this.onEvent = onEvent
    await this.startImpl()
  }

  protected abstract startImpl(): Promise<void>

  abstract stop(): Promise<void>

  abstract send(message: GatewayOutboundMessage): Promise<void>

  sendStreamingUpdate?(_message: GatewayOutboundMessage): Promise<void>

  protected async emit(event: GatewayInboundEvent): Promise<void> {
    if (!this.onEvent) {
      throw new Error(`${this.kind} adapter started without an event handler`)
    }
    await this.onEvent(event)
  }
}
