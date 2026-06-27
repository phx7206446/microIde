import { createGatewayLogger } from './logger.js'
import { GatewayPairingStore } from './pairing.js'
import { loadGatewayConfig } from './config.js'
import { GatewayRuntime } from './runtime.js'
import {
  GATEWAY_PLATFORMS,
  type GatewayPlatform,
} from './types.js'

type GatewayPairingAction =
  | { kind: 'list'; platform?: GatewayPlatform }
  | { kind: 'approve'; platform: GatewayPlatform; code: string }
  | { kind: 'revoke'; platform: GatewayPlatform; userId: string }

export type GatewayPairingCliOptions = {
  pairingList?: boolean
  pairingPlatform?: string
  pairingApprove?: string
  pairingRevoke?: string
}

function isGatewayPlatform(value: string): value is GatewayPlatform {
  return (GATEWAY_PLATFORMS as readonly string[]).includes(value)
}

function parseGatewayPlatform(value: string, label: string): GatewayPlatform {
  if (!isGatewayPlatform(value)) {
    throw new Error(
      `Invalid ${label}: ${value}. Expected one of ${GATEWAY_PLATFORMS.join(', ')}`,
    )
  }
  return value
}

function parsePairingTuple(
  value: string,
  label: '--pairing-approve' | '--pairing-revoke',
): [GatewayPlatform, string] {
  const [platformValue, payload] = value.split(':', 2)
  if (!platformValue || !payload) {
    throw new Error(
      `${label} must be <platform:${label === '--pairing-approve' ? 'code' : 'userId'}>`,
    )
  }
  return [parseGatewayPlatform(platformValue, label), payload]
}

export function formatGatewayCliError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.startsWith('Error: ') ? message.slice('Error: '.length) : message
}

export function getGatewayPairingActionFromOptions(
  options: GatewayPairingCliOptions,
): GatewayPairingAction | null {
  if (options.pairingList) {
    return {
      kind: 'list',
      platform: options.pairingPlatform
        ? parseGatewayPlatform(options.pairingPlatform, '--pairing-platform')
        : undefined,
    }
  }

  if (options.pairingApprove) {
    const [platform, code] = parsePairingTuple(
      options.pairingApprove,
      '--pairing-approve',
    )
    return { kind: 'approve', platform, code }
  }

  if (options.pairingRevoke) {
    const [platform, userId] = parsePairingTuple(
      options.pairingRevoke,
      '--pairing-revoke',
    )
    return { kind: 'revoke', platform, userId }
  }

  return null
}

export function getGatewayPairingActionFromCliArgs(
  rawCliArgs: readonly string[],
): GatewayPairingAction | null {
  if (rawCliArgs[0] !== 'gateway') {
    return null
  }

  const pairingPlatformIndex = rawCliArgs.indexOf('--pairing-platform')
  const pairingPlatformArg = rawCliArgs.find(arg =>
    arg.startsWith('--pairing-platform='),
  )
  const pairingPlatform = pairingPlatformArg
    ? pairingPlatformArg.slice('--pairing-platform='.length)
    : pairingPlatformIndex !== -1
      ? rawCliArgs[pairingPlatformIndex + 1]
      : undefined

  const pairingApproveArg = rawCliArgs.find(arg =>
    arg.startsWith('--pairing-approve='),
  )
  const pairingApproveIndex = rawCliArgs.indexOf('--pairing-approve')
  const pairingApprove = pairingApproveArg
    ? pairingApproveArg.slice('--pairing-approve='.length)
    : pairingApproveIndex !== -1
      ? rawCliArgs[pairingApproveIndex + 1]
      : undefined

  const pairingRevokeArg = rawCliArgs.find(arg =>
    arg.startsWith('--pairing-revoke='),
  )
  const pairingRevokeIndex = rawCliArgs.indexOf('--pairing-revoke')
  const pairingRevoke = pairingRevokeArg
    ? pairingRevokeArg.slice('--pairing-revoke='.length)
    : pairingRevokeIndex !== -1
      ? rawCliArgs[pairingRevokeIndex + 1]
      : undefined

  return getGatewayPairingActionFromOptions({
    pairingList: rawCliArgs.includes('--pairing-list'),
    pairingPlatform,
    pairingApprove,
    pairingRevoke,
  })
}

export async function runGatewayCommand(options: {
  config: string
  platforms?: string[]
}): Promise<void> {
  const config = await loadGatewayConfig(options.config)
  const logger = createGatewayLogger()
  const runtime = new GatewayRuntime(config, logger)
  const selected = options.platforms as GatewayPlatform[] | undefined

  await runtime.start(selected)
  logger.info(
    `Gateway started for ${runtime.getRunningPlatforms().join(', ')} using ${config.configPath}`,
  )

  await new Promise<void>((resolve, reject) => {
    let shuttingDown = false
    const shutdown = async () => {
      if (shuttingDown) {
        return
      }
      shuttingDown = true
      try {
        await runtime.stop()
        resolve()
      } catch (error) {
        reject(error)
      }
    }
    process.once('SIGINT', () => void shutdown())
    process.once('SIGTERM', () => void shutdown())
  })
}

export async function runGatewayPairingAction(
  action: GatewayPairingAction,
): Promise<void> {
  switch (action.kind) {
    case 'list':
      await runGatewayPairingListCommand({ platform: action.platform })
      return
    case 'approve':
      await runGatewayPairingApproveCommand(action)
      return
    case 'revoke':
      await runGatewayPairingRevokeCommand(action)
      return
  }
}

export async function runGatewayPairingListCommand(options: {
  platform?: string
}): Promise<void> {
  const store = new GatewayPairingStore()
  const platform = options.platform
    ? parseGatewayPlatform(options.platform, 'platform')
    : undefined
  const [pending, approved] = await Promise.all([
    store.listPending(platform),
    store.listApproved(platform),
  ])

  process.stdout.write('Pending Pairings\n')
  if (pending.length === 0) {
    process.stdout.write('  (none)\n')
  } else {
    for (const entry of pending) {
      process.stdout.write(
        `  ${entry.platform} code=${entry.code} user=${entry.userId}${entry.userName ? ` (${entry.userName})` : ''}\n`,
      )
    }
  }

  process.stdout.write('\nApproved Pairings\n')
  if (approved.length === 0) {
    process.stdout.write('  (none)\n')
    return
  }
  for (const entry of approved) {
    process.stdout.write(
      `  ${entry.platform} user=${entry.userId}${entry.userName ? ` (${entry.userName})` : ''}\n`,
    )
  }
}

export async function runGatewayPairingApproveCommand(options: {
  platform: string
  code: string
}): Promise<void> {
  const store = new GatewayPairingStore()
  const platform = parseGatewayPlatform(options.platform, 'platform')
  const result = await store.approveCode(platform, options.code)
  if (!result) {
    throw new Error('Pairing code not found or expired')
  }
  process.stdout.write(
    `Approved ${result.platform}:${result.userId}${result.userName ? ` (${result.userName})` : ''}\n`,
  )
}

export async function runGatewayPairingRevokeCommand(options: {
  platform: string
  userId: string
}): Promise<void> {
  const store = new GatewayPairingStore()
  const platform = parseGatewayPlatform(options.platform, 'platform')
  const revoked = await store.revoke(platform, options.userId)
  if (!revoked) {
    throw new Error(`No approved pairing found for ${platform}:${options.userId}`)
  }
  process.stdout.write(`Revoked ${platform}:${options.userId}\n`)
}
