import type { Command } from '../commands.js'
import { isReplBridgeActive } from '../bootstrap/state.js'
import { getReplBridgeHandle } from '../bridge/replBridgeHandle.js'
import type { LocalCommandCall } from '../types/command.js'

const REPOSITORY_PATTERN = /^[^/\s]+\/[^/\s]+$/
const HELP_TEXT = [
  'Usage: /subscribe-pr [off|unsubscribe] <owner/repo> <pr-number>',
  '   or: /subscribe-pr <owner/repo>#<pr-number>',
].join('\n')

type SubscribeAction = 'subscribe' | 'unsubscribe'

type ParsedTarget = {
  action: SubscribeAction
  repository: string
  prNumber: number
}

function parsePRNumber(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null
  }

  const parsed = Number.parseInt(value, 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function parseTarget(args: string): ParsedTarget | null {
  const tokens = args
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (tokens.length === 0) {
    return null
  }

  let action: SubscribeAction = 'subscribe'
  if (tokens[0] === 'off' || tokens[0] === 'unsubscribe') {
    action = 'unsubscribe'
    tokens.shift()
  }

  if (tokens.length === 1) {
    const [repository, prNumberRaw] = tokens[0]!.split('#')
    if (!repository || !prNumberRaw) {
      return null
    }

    const prNumber = parsePRNumber(prNumberRaw)
    if (!prNumber) {
      return null
    }

    return {
      action,
      repository,
      prNumber,
    }
  }

  if (tokens.length === 2) {
    const repository = tokens[0]!
    const prNumber = parsePRNumber(tokens[1]!)
    if (!prNumber) {
      return null
    }

    return {
      action,
      repository,
      prNumber,
    }
  }

  return null
}

function getBridgeHandle(): NonNullable<ReturnType<typeof getReplBridgeHandle>> {
  const handle = getReplBridgeHandle()
  if (!handle || !isReplBridgeActive()) {
    throw new Error(
      'Remote Control is not connected. Reconnect with /remote-control before managing PR activity subscriptions.',
    )
  }
  return handle
}

export const call: LocalCommandCall = async args => {
  const parsed = parseTarget(args)
  if (!parsed || !REPOSITORY_PATTERN.test(parsed.repository)) {
    return {
      type: 'text',
      value: HELP_TEXT,
    }
  }

  const handle = getBridgeHandle()
  const result =
    parsed.action === 'unsubscribe'
      ? await handle.unsubscribePR({
          repository: parsed.repository,
          prNumber: parsed.prNumber,
        })
      : await handle.subscribePR({
          repository: parsed.repository,
          prNumber: parsed.prNumber,
        })

  return {
    type: 'text',
    value: result.message,
  }
}

const subscribePr = {
  type: 'local',
  name: 'subscribe-pr',
  description: 'Manage GitHub pull request activity delivery for Remote Control',
  argumentHint: '[off|unsubscribe] <owner/repo> <pr-number>',
  supportsNonInteractive: false,
  immediate: true,
  load: async () => ({ call }),
} satisfies Command

export default subscribePr
