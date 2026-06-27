import {
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'fs/promises'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { isProcessRunning } from '../utils/genericProcessUtils.js'
import { safeParseJSON } from '../utils/json.js'
import { jsonStringify } from '../utils/slowOperations.js'

export type ServerLock = {
  pid: number
  port: number
  host: string
  httpUrl: string
  startedAt: number
}

function getLockPath(): string {
  return join(getClaudeConfigHomeDir(), 'server.lock.json')
}

export async function writeServerLock(lock: ServerLock): Promise<void> {
  const lockPath = getLockPath()
  await mkdir(getClaudeConfigHomeDir(), { recursive: true })
  await writeFile(lockPath, jsonStringify(lock, null, 2), 'utf8')
}

export async function removeServerLock(): Promise<void> {
  await rm(getLockPath(), { force: true })
}

export async function probeRunningServer(): Promise<ServerLock | null> {
  let contents: string
  try {
    contents = await readFile(getLockPath(), 'utf8')
  } catch {
    return null
  }

  const parsed = safeParseJSON(contents) as Record<string, unknown> | null
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof parsed.pid !== 'number' ||
    typeof parsed.httpUrl !== 'string'
  ) {
    await removeServerLock().catch(() => {})
    return null
  }

  const lock = parsed as unknown as ServerLock
  if (!isProcessRunning(lock.pid)) {
    await removeServerLock().catch(() => {})
    return null
  }

  const healthy = await probeHealth(lock.httpUrl)
  if (!healthy) {
    await removeServerLock().catch(() => {})
    return null
  }

  return lock
}

async function probeHealth(httpUrl: string): Promise<boolean> {
  try {
    if (httpUrl.startsWith('unix:')) {
      const response = await fetch('http://localhost/health', {
        unix: httpUrl.slice('unix:'.length),
        signal: AbortSignal.timeout(1_000),
      } as RequestInit & { unix: string })
      return response.ok
    }

    const response = await fetch(`${httpUrl}/health`, {
      signal: AbortSignal.timeout(1_000),
    })
    return response.ok
  } catch {
    return false
  }
}
