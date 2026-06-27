import type { ExternalPermissionMode } from '../types/permissions.js'

export const GATEWAY_PLATFORMS = ['feishu', 'weixin'] as const
export type GatewayPlatform = (typeof GATEWAY_PLATFORMS)[number]

export type GatewaySessionMode = 'direct' | 'channel'

export type GatewayPermissionMode = ExternalPermissionMode

export const GATEWAY_DM_POLICIES = ['pairing', 'allowlist', 'open'] as const
export type GatewayDmPolicy = (typeof GATEWAY_DM_POLICIES)[number]

export const GATEWAY_GROUP_POLICIES = [
  'open',
  'mention',
  'allowlist',
] as const
export type GatewayGroupPolicy = (typeof GATEWAY_GROUP_POLICIES)[number]

export type GatewaySessionKeyStrategy = 'chat' | 'thread' | 'user'

export type GatewayChatType = 'dm' | 'group' | 'unknown'

export type GatewayInboundEvent = {
  platform: GatewayPlatform
  eventId: string
  senderId: string
  senderName?: string
  chatId: string
  chatName?: string
  chatType?: GatewayChatType
  threadId?: string
  text: string
  mentionsSelf?: boolean
  replyToMessageId?: string
  replyToText?: string
  metadata?: Record<string, string>
}

export type GatewayTurnUpdate = {
  text: string
  sequence: number
}

export type GatewayOutboundMessage = {
  platform: GatewayPlatform
  chatId: string
  threadId?: string
  text: string
  replyToMessageId?: string
  streamId?: string
  phase?: 'partial' | 'final'
  sequence?: number
  metadata?: Record<string, string | number | boolean>
}

export type GatewayTurnResult = {
  sessionId: string
  message: string
}
