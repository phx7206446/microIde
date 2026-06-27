import axios from 'axios'
import { randomUUID } from 'crypto'
import { mkdir, readdir, readFile, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import type { Message } from '../types/message.js'
import { getSessionId } from '../bootstrap/state.js'
import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import { parseGitRemote } from './detectRepository.js'
import { isEnvTruthy, getClaudeConfigHomeDir } from './envUtils.js'
import { errorMessage } from './errors.js'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'
import {
  getChangedFiles,
  getGitState,
  preserveGitStateForIssue,
} from './git.js'
import { getRemoteUrlForDir } from './git/gitFilesystem.js'
import { logError } from './log.js'
import { isHumanTurn } from './messagePredicates.js'
import { sequential } from './sequential.js'
import { getSessionIngressAuthToken } from './sessionIngressAuth.js'
import { sleep } from './sleep.js'
import { jsonStringify } from './slowOperations.js'

const GCLOUD_AUTH_TIMEOUT_MS = 5_000
const UPLOAD_TIMEOUT_MS = 10_000
const MAX_UPLOAD_RETRIES = 3
const BASE_RETRY_DELAY_MS = 500

type SessionEnvironmentSnapshot = {
  type: 'session_environment'
  uuid: string
  sessionId: string
  turnIndex: number
  createdAt: string
  cwd: string
  remoteUrl: string | null
  gitState: Awaited<ReturnType<typeof getGitState>>
  preservedGitState: Awaited<ReturnType<typeof preserveGitStateForIssue>>
  changedFiles: string[]
  messageRefs: {
    lastHumanTurnUuid: string | null
    lastAssistantUuid: string | null
  }
}

type QueuedSnapshotFile = {
  path: string
  turnIndex: number
}

function getSessionDataDir(sessionId: string): string {
  return join(getClaudeConfigHomeDir(), 'session-data', sessionId)
}

function getSnapshotPath(sessionId: string, turnIndex: number): string {
  return join(
    getSessionDataDir(sessionId),
    `turn-${String(turnIndex).padStart(6, '0')}.json`,
  )
}

async function isAnthropicOwnedRepo(cwd: string): Promise<boolean> {
  const remoteUrl = await getRemoteUrlForDir(cwd)
  if (!remoteUrl) {
    return false
  }

  const parsed = parseGitRemote(remoteUrl)
  return parsed?.host === 'github.com' && parsed.owner === 'anthropics'
}

async function hasGcloudAuth(): Promise<boolean> {
  const result = await execFileNoThrowWithCwd(
    'gcloud',
    ['auth', 'print-access-token'],
    {
      cwd: getCwd(),
      preserveOutputOnError: false,
      timeout: GCLOUD_AUTH_TIMEOUT_MS,
    },
  )

  return result.code === 0 && result.stdout.trim().length > 0
}

function getTurnIndex(messages: Message[]): number {
  let count = 0
  for (const message of messages) {
    if (isHumanTurn(message)) {
      count += 1
    }
  }
  return count
}

function findLastHumanTurnUuid(messages: Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message && isHumanTurn(message)) {
      return message.uuid
    }
  }
  return null
}

function findLastAssistantUuid(messages: Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message?.type === 'assistant') {
      return message.uuid
    }
  }
  return null
}

async function captureSnapshot(
  sessionId: string,
  turnIndex: number,
  messages: Message[],
): Promise<SessionEnvironmentSnapshot> {
  const cwd = getCwd()
  const remoteUrl = await getRemoteUrlForDir(cwd)
  const [gitState, preservedGitState, changedFiles] = await Promise.all([
    getGitState(),
    preserveGitStateForIssue(),
    getChangedFiles().catch(() => []),
  ])

  return {
    type: 'session_environment',
    uuid: randomUUID(),
    sessionId,
    turnIndex,
    createdAt: new Date().toISOString(),
    cwd,
    remoteUrl,
    gitState,
    preservedGitState,
    changedFiles,
    messageRefs: {
      lastHumanTurnUuid: findLastHumanTurnUuid(messages),
      lastAssistantUuid: findLastAssistantUuid(messages),
    },
  }
}

async function enqueueSnapshot(snapshot: SessionEnvironmentSnapshot): Promise<void> {
  const sessionDir = getSessionDataDir(snapshot.sessionId)
  await mkdir(sessionDir, { recursive: true, mode: 0o700 })
  await writeFile(
    getSnapshotPath(snapshot.sessionId, snapshot.turnIndex),
    jsonStringify(snapshot, null, 2),
    { encoding: 'utf8', mode: 0o600 },
  )
}

async function listQueuedSnapshots(sessionId: string): Promise<QueuedSnapshotFile[]> {
  const sessionDir = getSessionDataDir(sessionId)
  let files: string[]
  try {
    files = await readdir(sessionDir)
  } catch {
    return []
  }

  return files
    .map(filename => {
      const match = filename.match(/^turn-(\d+)\.json$/)
      if (!match?.[1]) {
        return null
      }
      return {
        path: join(sessionDir, filename),
        turnIndex: Number(match[1]),
      }
    })
    .filter((value): value is QueuedSnapshotFile => value !== null)
    .sort((a, b) => a.turnIndex - b.turnIndex)
}

function getRemoteUploadConfig():
  | {
      baseUrl: string
      remoteSessionId: string
      sessionToken: string
      workerEpoch: number
    }
  | null {
  const remoteSessionId = process.env.CLAUDE_CODE_REMOTE_SESSION_ID
  const sessionToken = getSessionIngressAuthToken()
  const workerEpochRaw = process.env.CLAUDE_CODE_WORKER_EPOCH
  const baseUrl =
    process.env.CLAUDE_CODE_API_BASE_URL ||
    process.env.ANTHROPIC_BASE_URL ||
    null

  if (!remoteSessionId || !sessionToken || !workerEpochRaw || !baseUrl) {
    return null
  }

  const workerEpoch = Number(workerEpochRaw)
  if (!Number.isSafeInteger(workerEpoch)) {
    return null
  }

  return {
    baseUrl,
    remoteSessionId,
    sessionToken,
    workerEpoch,
  }
}

async function uploadQueuedSnapshot(
  file: QueuedSnapshotFile,
  uploadConfig: NonNullable<ReturnType<typeof getRemoteUploadConfig>>,
): Promise<boolean> {
  const raw = await readFile(file.path, 'utf8')
  const payload = JSON.parse(raw) as SessionEnvironmentSnapshot
  const url = `${uploadConfig.baseUrl}/v1/code/sessions/${uploadConfig.remoteSessionId}/worker/internal-events`

  for (let attempt = 1; attempt <= MAX_UPLOAD_RETRIES; attempt += 1) {
    try {
      const response = await axios.post(
        url,
        {
          worker_epoch: uploadConfig.workerEpoch,
          events: [
            {
              payload: {
                ...payload,
                uuid: payload.uuid || randomUUID(),
              },
            },
          ],
        },
        {
          headers: {
            Authorization: `Bearer ${uploadConfig.sessionToken}`,
            'Content-Type': 'application/json',
          },
          timeout: UPLOAD_TIMEOUT_MS,
          validateStatus: status => status < 500,
        },
      )

      if (response.status === 200 || response.status === 201 || response.status === 204) {
        await unlink(file.path).catch(() => {})
        return true
      }

      if (
        response.status === 401 ||
        response.status === 403 ||
        response.status === 404 ||
        response.status === 409
      ) {
        logForDebugging(
          `[session-data] Internal upload rejected for turn ${file.turnIndex} with ${response.status}`,
          { level: 'warn' },
        )
        return false
      }
    } catch (error) {
      if (attempt === MAX_UPLOAD_RETRIES) {
        logForDebugging(
          `[session-data] Upload failed for turn ${file.turnIndex}: ${errorMessage(error)}`,
          { level: 'warn' },
        )
        return false
      }
    }

    await sleep(BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1))
  }

  return false
}

async function flushQueuedSnapshots(sessionId: string): Promise<void> {
  const uploadConfig = getRemoteUploadConfig()
  if (!uploadConfig) {
    return
  }

  const queued = await listQueuedSnapshots(sessionId)
  for (const file of queued) {
    const uploaded = await uploadQueuedSnapshot(file, uploadConfig)
    if (!uploaded) {
      break
    }
  }
}

export async function createSessionTurnUploader(): Promise<
  ((messages: Message[]) => Promise<void>) | null
> {
  if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_SESSION_DATA_UPLOAD)) {
    return null
  }

  const sessionId = getSessionId()
  let lastQueuedTurnIndex = 0

  return sequential(async (messages: Message[]) => {
    const turnIndex = getTurnIndex(messages)
    if (turnIndex === 0) {
      return
    }

    const cwd = getCwd()
    const [anthropicRepo, gcloudAuth] = await Promise.all([
      isAnthropicOwnedRepo(cwd),
      hasGcloudAuth(),
    ])

    if (!anthropicRepo || !gcloudAuth) {
      return
    }

    if (turnIndex > lastQueuedTurnIndex) {
      try {
        const snapshot = await captureSnapshot(sessionId, turnIndex, messages)
        await enqueueSnapshot(snapshot)
        lastQueuedTurnIndex = turnIndex
      } catch (error) {
        logError(
          new Error(
            `[session-data] Failed to capture turn ${turnIndex}: ${errorMessage(error)}`,
          ),
        )
        return
      }
    }

    try {
      await flushQueuedSnapshots(sessionId)
    } catch (error) {
      logForDebugging(
        `[session-data] Flush failed for session ${sessionId}: ${errorMessage(error)}`,
        { level: 'warn' },
      )
    }
  })
}
