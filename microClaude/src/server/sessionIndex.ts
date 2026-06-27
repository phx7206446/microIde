import { mkdir, readFile, rename, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { safeParseJSON } from '../utils/json.js'
import { jsonStringify } from '../utils/slowOperations.js'
import { getProjectDir } from '../utils/sessionStoragePortable.js'
import type { SessionIndex, SessionIndexEntry } from './types.js'

function getSessionIndexPath(): string {
  return join(getClaudeConfigHomeDir(), 'server-sessions.json')
}

function isSessionIndexEntry(value: unknown): value is SessionIndexEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as SessionIndexEntry).sessionId === 'string' &&
    typeof (value as SessionIndexEntry).transcriptSessionId === 'string' &&
    typeof (value as SessionIndexEntry).cwd === 'string' &&
    typeof (value as SessionIndexEntry).createdAt === 'number' &&
    typeof (value as SessionIndexEntry).lastActiveAt === 'number' &&
    ((value as SessionIndexEntry).permissionMode === undefined ||
      typeof (value as SessionIndexEntry).permissionMode === 'string')
  )
}

function normalizeSessionIndex(value: unknown): SessionIndex {
  if (!value || typeof value !== 'object') {
    return {}
  }

  const index: SessionIndex = {}
  for (const [sessionKey, entry] of Object.entries(value)) {
    if (isSessionIndexEntry(entry)) {
      index[sessionKey] = entry
    }
  }
  return index
}

async function writeIndexFile(index: SessionIndex): Promise<void> {
  const configDir = getClaudeConfigHomeDir()
  const indexPath = getSessionIndexPath()
  const tempPath = `${indexPath}.${process.pid}.tmp`
  const payload = jsonStringify(index, null, 2)

  await mkdir(configDir, { recursive: true })
  await writeFile(tempPath, payload, 'utf8')
  await rename(tempPath, indexPath)
}

export async function transcriptExistsForSession(
  cwd: string,
  transcriptSessionId: string,
): Promise<boolean> {
  const transcriptPath = join(
    getProjectDir(cwd),
    `${transcriptSessionId}.jsonl`,
  )
  try {
    await stat(transcriptPath)
    return true
  } catch {
    return false
  }
}

export class SessionIndexStore {
  private loaded = false
  private index: SessionIndex = {}
  private writeQueue: Promise<void> = Promise.resolve()

  async get(sessionKey: string): Promise<SessionIndexEntry | undefined> {
    await this.ensureLoaded()
    return this.index[sessionKey]
  }

  async set(sessionKey: string, entry: SessionIndexEntry): Promise<void> {
    await this.ensureLoaded()
    this.index[sessionKey] = entry
    await this.flush()
  }

  async touch(
    sessionKey: string,
    updates: Partial<SessionIndexEntry>,
  ): Promise<void> {
    await this.ensureLoaded()
    const existing = this.index[sessionKey]
    if (!existing) {
      return
    }
    this.index[sessionKey] = {
      ...existing,
      ...updates,
    }
    await this.flush()
  }

  async delete(sessionKey: string): Promise<void> {
    await this.ensureLoaded()
    if (!(sessionKey in this.index)) {
      return
    }
    delete this.index[sessionKey]
    await this.flush()
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return
    }

    let contents: string | undefined
    try {
      contents = await readFile(getSessionIndexPath(), 'utf8')
    } catch {
      this.loaded = true
      this.index = {}
      return
    }

    this.loaded = true
    this.index = normalizeSessionIndex(safeParseJSON(contents))
  }

  private async flush(): Promise<void> {
    const snapshot = { ...this.index }
    this.writeQueue = this.writeQueue
      .then(() => writeIndexFile(snapshot))
      .catch(async () => {
        // Retry once on the current snapshot after clearing any stale temp file.
        await rm(`${getSessionIndexPath()}.${process.pid}.tmp`, {
          force: true,
        }).catch(() => {})
        await writeIndexFile(snapshot)
      })
    await this.writeQueue
  }
}
