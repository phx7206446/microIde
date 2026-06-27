import { randomInt } from 'crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'fs/promises'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { safeParseJSON } from '../utils/json.js'
import { jsonStringify } from '../utils/slowOperations.js'
import type { GatewayPlatform } from './types.js'

const PAIRING_DIRNAME = 'gateway-pairing'
const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const PAIRING_CODE_LENGTH = 8
const PAIRING_CODE_TTL_MS = 60 * 60 * 1000
const PAIRING_RATE_LIMIT_MS = 10 * 60 * 1000
const PAIRING_LOCKOUT_MS = 60 * 60 * 1000
const PAIRING_MAX_PENDING_PER_PLATFORM = 8
const PAIRING_MAX_FAILED_APPROVALS = 5

type PendingPairingEntry = {
  userId: string
  userName?: string
  createdAt: number
}

type ApprovedPairingEntry = {
  userName?: string
  approvedAt: number
}

type PendingPairingStore = Record<string, PendingPairingEntry>
type ApprovedPairingStore = Record<string, ApprovedPairingEntry>
type PairingMetaStore = Record<string, number>

export type GatewayPairingRequestResult =
  | { kind: 'created'; code: string }
  | { kind: 'rate_limited' }
  | { kind: 'locked' }
  | { kind: 'capacity_exceeded' }

export type GatewayPendingPairing = {
  platform: GatewayPlatform
  code: string
  userId: string
  userName?: string
  createdAt: number
}

export type GatewayApprovedPairing = {
  platform: GatewayPlatform
  userId: string
  userName?: string
  approvedAt: number
}

function getGatewayPairingDir(): string {
  return join(getClaudeConfigHomeDir(), PAIRING_DIRNAME)
}

function pendingPath(platform: GatewayPlatform): string {
  return join(getGatewayPairingDir(), `${platform}-pending.json`)
}

function approvedPath(platform: GatewayPlatform): string {
  return join(getGatewayPairingDir(), `${platform}-approved.json`)
}

function metaPath(): string {
  return join(getGatewayPairingDir(), '_meta.json')
}

function normalizeRecord<T>(value: unknown): Record<string, T> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  return value as Record<string, T>
}

async function readJsonFile<T>(filePath: string): Promise<Record<string, T>> {
  try {
    return normalizeRecord<T>(safeParseJSON(await readFile(filePath, 'utf8')))
  } catch {
    return {}
  }
}

async function writeJsonFile(
  filePath: string,
  value: Record<string, unknown>,
): Promise<void> {
  const directory = getGatewayPairingDir()
  const tempPath = `${filePath}.${process.pid}.tmp`
  await mkdir(directory, { recursive: true })
  await writeFile(tempPath, jsonStringify(value, null, 2), 'utf8')
  await rename(tempPath, filePath)
  await chmod(filePath, 0o600).catch(() => {})
}

function createPairingCode(): string {
  let result = ''
  for (let index = 0; index < PAIRING_CODE_LENGTH; index += 1) {
    result += PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)]
  }
  return result
}

export class GatewayPairingStore {
  private queue: Promise<void> = Promise.resolve()

  async isApproved(
    platform: GatewayPlatform,
    userId: string,
  ): Promise<boolean> {
    const approved = await readJsonFile<ApprovedPairingEntry>(approvedPath(platform))
    return userId in approved
  }

  async generateCode(
    platform: GatewayPlatform,
    userId: string,
    userName?: string,
  ): Promise<GatewayPairingRequestResult> {
    return this.runExclusive(async () => {
      await this.cleanupExpired(platform)

      const meta = await this.loadMeta()
      if (this.isLocked(meta, platform)) {
        return { kind: 'locked' }
      }
      if (this.isRateLimited(meta, platform, userId)) {
        return { kind: 'rate_limited' }
      }

      const pending = await readJsonFile<PendingPairingEntry>(pendingPath(platform))
      if (Object.keys(pending).length >= PAIRING_MAX_PENDING_PER_PLATFORM) {
        return { kind: 'capacity_exceeded' }
      }

      let code = createPairingCode()
      for (let attempt = 0; attempt < 8 && code in pending; attempt += 1) {
        code = createPairingCode()
      }
      if (code in pending) {
        return { kind: 'capacity_exceeded' }
      }

      pending[code] = {
        userId,
        ...(userName ? { userName } : {}),
        createdAt: Date.now(),
      }
      meta[`${platform}:${userId}`] = Date.now()

      await Promise.all([
        writeJsonFile(pendingPath(platform), pending),
        writeJsonFile(metaPath(), meta),
      ])

      return { kind: 'created', code }
    })
  }

  async approveCode(
    platform: GatewayPlatform,
    code: string,
  ): Promise<GatewayApprovedPairing | null> {
    return this.runExclusive(async () => {
      await this.cleanupExpired(platform)

      const normalizedCode = code.trim().toUpperCase()
      const pending = await readJsonFile<PendingPairingEntry>(pendingPath(platform))
      const entry = pending[normalizedCode]
      if (!entry) {
        const meta = await this.loadMeta()
        const failureKey = `_failures:${platform}`
        const failures = (meta[failureKey] ?? 0) + 1
        meta[failureKey] = failures
        if (failures >= PAIRING_MAX_FAILED_APPROVALS) {
          meta[`_lockout:${platform}`] = Date.now() + PAIRING_LOCKOUT_MS
          meta[failureKey] = 0
        }
        await writeJsonFile(metaPath(), meta)
        return null
      }

      delete pending[normalizedCode]

      const approved = await readJsonFile<ApprovedPairingEntry>(approvedPath(platform))
      approved[entry.userId] = {
        ...(entry.userName ? { userName: entry.userName } : {}),
        approvedAt: Date.now(),
      }

      const meta = await this.loadMeta()
      delete meta[`_failures:${platform}`]
      delete meta[`_lockout:${platform}`]

      await Promise.all([
        writeJsonFile(pendingPath(platform), pending),
        writeJsonFile(approvedPath(platform), approved),
        writeJsonFile(metaPath(), meta),
      ])

      return {
        platform,
        userId: entry.userId,
        ...(entry.userName ? { userName: entry.userName } : {}),
        approvedAt: approved[entry.userId]!.approvedAt,
      }
    })
  }

  async revoke(platform: GatewayPlatform, userId: string): Promise<boolean> {
    return this.runExclusive(async () => {
      const approved = await readJsonFile<ApprovedPairingEntry>(approvedPath(platform))
      if (!(userId in approved)) {
        return false
      }
      delete approved[userId]
      await writeJsonFile(approvedPath(platform), approved)
      return true
    })
  }

  async listPending(
    platform?: GatewayPlatform,
  ): Promise<GatewayPendingPairing[]> {
    return this.runExclusive(async () => {
      const platforms = platform ? [platform] : (['feishu', 'weixin'] as const)
      const results: GatewayPendingPairing[] = []
      for (const current of platforms) {
        await this.cleanupExpired(current)
        const pending = await readJsonFile<PendingPairingEntry>(pendingPath(current))
        for (const [code, entry] of Object.entries(pending)) {
          results.push({
            platform: current,
            code,
            userId: entry.userId,
            ...(entry.userName ? { userName: entry.userName } : {}),
            createdAt: entry.createdAt,
          })
        }
      }
      return results.sort((left, right) => left.createdAt - right.createdAt)
    })
  }

  async listApproved(
    platform?: GatewayPlatform,
  ): Promise<GatewayApprovedPairing[]> {
    const platforms = platform ? [platform] : (['feishu', 'weixin'] as const)
    const results: GatewayApprovedPairing[] = []
    for (const current of platforms) {
      const approved = await readJsonFile<ApprovedPairingEntry>(approvedPath(current))
      for (const [userId, entry] of Object.entries(approved)) {
        results.push({
          platform: current,
          userId,
          ...(entry.userName ? { userName: entry.userName } : {}),
          approvedAt: entry.approvedAt,
        })
      }
    }
    return results.sort((left, right) => left.approvedAt - right.approvedAt)
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue
    let release: () => void = () => {}
    this.queue = new Promise<void>(resolve => {
      release = resolve
    })

    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }

  private async cleanupExpired(platform: GatewayPlatform): Promise<void> {
    const pending = await readJsonFile<PendingPairingEntry>(pendingPath(platform))
    const now = Date.now()
    let changed = false
    for (const [code, entry] of Object.entries(pending)) {
      if (now - entry.createdAt > PAIRING_CODE_TTL_MS) {
        delete pending[code]
        changed = true
      }
    }
    if (!changed) {
      return
    }
    await writeJsonFile(pendingPath(platform), pending)
  }

  private async loadMeta(): Promise<PairingMetaStore> {
    return readJsonFile<number>(metaPath())
  }

  private isRateLimited(
    meta: PairingMetaStore,
    platform: GatewayPlatform,
    userId: string,
  ): boolean {
    const lastIssuedAt = meta[`${platform}:${userId}`] ?? 0
    return Date.now() - lastIssuedAt < PAIRING_RATE_LIMIT_MS
  }

  private isLocked(meta: PairingMetaStore, platform: GatewayPlatform): boolean {
    const lockedUntil = meta[`_lockout:${platform}`] ?? 0
    return lockedUntil > Date.now()
  }
}
