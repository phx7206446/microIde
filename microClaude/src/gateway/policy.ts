import type { GatewayPlatformConfig } from './config.js'
import {
  GatewayPairingStore,
  type GatewayPairingRequestResult,
} from './pairing.js'
import type { GatewayInboundEvent } from './types.js'

type GatewayAuthorizationDecision =
  | { kind: 'allow' }
  | { kind: 'ignore'; reason: string }
  | { kind: 'reply'; message: string }

function isAllowlisted(
  allowFrom: readonly string[] | undefined,
  value: string,
): boolean {
  if (!allowFrom || allowFrom.length === 0) {
    return false
  }
  if (allowFrom.includes('*')) {
    return true
  }
  return allowFrom.includes(value)
}

async function isSenderAuthorized(
  platform: GatewayPlatformConfig,
  event: GatewayInboundEvent,
  pairingStore: GatewayPairingStore,
): Promise<boolean> {
  if (isAllowlisted(platform.allowFrom, event.senderId)) {
    return true
  }
  return pairingStore.isApproved(platform.kind, event.senderId)
}

function formatPairingMessage(
  platform: GatewayPlatformConfig['kind'],
  result: GatewayPairingRequestResult,
): string | undefined {
  if (result.kind === 'rate_limited') {
    return undefined
  }
  if (result.kind !== 'created') {
    return 'Pairing is temporarily unavailable. Try again later.'
  }
  return [
    "I don't recognize this account yet.",
    '',
    `Pairing code: \`${result.code}\``,
    '',
    'Approve it from the CLI with:',
    `\`claude gateway --pairing-approve ${platform}:${result.code}\``,
  ].join('\n')
}

export async function authorizeGatewayEvent(
  platform: GatewayPlatformConfig,
  event: GatewayInboundEvent,
  pairingStore: GatewayPairingStore,
): Promise<GatewayAuthorizationDecision> {
  const chatType = event.chatType ?? 'unknown'
  const senderAuthorized = await isSenderAuthorized(platform, event, pairingStore)

  if (chatType === 'dm') {
    if (senderAuthorized) {
      return { kind: 'allow' }
    }

    if (platform.dmPolicy !== 'pairing') {
      return { kind: 'ignore', reason: 'dm_sender_not_authorized' }
    }

    const pairingResult = await pairingStore.generateCode(
      platform.kind,
      event.senderId,
      event.senderName,
    )
    const message = formatPairingMessage(platform.kind, pairingResult)
    if (!message) {
      return { kind: 'ignore', reason: pairingResult.kind }
    }
    return { kind: 'reply', message }
  }

  if (!senderAuthorized) {
    return { kind: 'ignore', reason: 'group_sender_not_authorized' }
  }

  switch (platform.groupPolicy) {
    case 'open':
      return { kind: 'allow' }
    case 'mention':
      return event.mentionsSelf
        ? { kind: 'allow' }
        : { kind: 'ignore', reason: 'group_requires_mention' }
    case 'allowlist':
      return isAllowlisted(platform.groupAllowFrom, event.chatId)
        ? { kind: 'allow' }
        : { kind: 'ignore', reason: 'group_chat_not_allowlisted' }
    default:
      return { kind: 'ignore', reason: 'unsupported_group_policy' }
  }
}
