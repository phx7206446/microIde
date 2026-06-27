import type { SessionCronTask } from '../bootstrap/state.js'
import {
  getSessionCronTasks,
  getSessionId,
  getSessionProjectDir,
  isSessionPersistenceDisabled,
} from '../bootstrap/state.js'
import { mkdir, unlink, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { getCurrentProjectDir } from './projectIdentity.js'
import { isFsInaccessible } from './errors.js'
import { getFsImplementation } from './fsOperations.js'
import { safeParseJSON } from './json.js'
import { jsonStringify } from './slowOperations.js'

type SessionLoopTasksFile = {
  tasks: unknown[]
}

type SessionLoopTasksPathOptions = {
  sessionId?: string
  projectDir?: string
}

type RestorableLoopBase = Partial<SessionCronTask> & {
  id: string
  prompt: string
  createdAt: number
  recurring: true
  source: 'loop'
}

const SESSION_LOOP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export function getSessionLoopTasksPath(
  options: SessionLoopTasksPathOptions = {},
): string {
  const projectDir =
    options.projectDir ?? getSessionProjectDir() ?? getCurrentProjectDir()
  const sessionId = options.sessionId ?? getSessionId()
  return join(projectDir, `${sessionId}.loop-tasks.json`)
}

export async function readSessionLoopTasks(
  options: SessionLoopTasksPathOptions = {},
): Promise<SessionCronTask[]> {
  const fs = getFsImplementation()
  let raw: string
  try {
    raw = await fs.readFile(getSessionLoopTasksPath(options), {
      encoding: 'utf-8',
    })
  } catch (e) {
    if (isFsInaccessible(e)) return []
    throw e
  }

  const parsed = safeParseJSON(raw, false)
  if (!parsed || typeof parsed !== 'object') return []

  const tasks = (parsed as Partial<SessionLoopTasksFile>).tasks
  if (!Array.isArray(tasks)) return []

  const restored: SessionCronTask[] = []
  const now = Date.now()
  for (const task of tasks) {
    const normalized = normalizeRestorableLoopTask(task, now)
    if (normalized) restored.push(normalized)
  }
  return restored
}

export async function persistSessionLoopTasks(
  tasks: SessionCronTask[] = getSessionCronTasks(),
  options: SessionLoopTasksPathOptions = {},
): Promise<void> {
  if (isSessionPersistenceDisabled()) return

  const now = Date.now()
  const loopTasks = tasks
    .map(task => normalizeRestorableLoopTask(task, now))
    .filter((task): task is SessionCronTask => task !== null)
  const path = getSessionLoopTasksPath(options)
  if (loopTasks.length === 0) {
    try {
      await unlink(path)
    } catch (e) {
      if (isFsInaccessible(e)) return
      throw e
    }
    return
  }

  await mkdir(dirname(path), { recursive: true })
  await writeFile(
    path,
    jsonStringify({ tasks: loopTasks }, null, 2) + '\n',
    'utf-8',
  )
}

function normalizeRestorableLoopTask(
  task: unknown,
  now: number,
): SessionCronTask | null {
  if (!task || typeof task !== 'object') return null
  const candidate = task as Partial<SessionCronTask>
  if (
    typeof candidate.id !== 'string' ||
    typeof candidate.prompt !== 'string' ||
    typeof candidate.createdAt !== 'number' ||
    candidate.recurring !== true ||
    candidate.source !== 'loop'
  ) {
    return null
  }
  const base = {
    ...candidate,
    id: candidate.id,
    prompt: candidate.prompt,
    createdAt: candidate.createdAt,
    recurring: true as const,
    source: 'loop' as const,
  }
  if (isExpiredSessionTask(base, now)) return null

  if (candidate.loopMode === 'fixed') {
    if (typeof candidate.cron !== 'string') return null
    return buildRestorableLoopTask(base, {
      loopMode: 'fixed',
      cron: candidate.cron,
    })
  }

  if (candidate.loopMode === 'dynamic') {
    if (typeof candidate.nextFireAt !== 'number') return null
    return buildRestorableLoopTask(base, {
      loopMode: 'dynamic',
      nextFireAt: candidate.nextFireAt,
    })
  }

  return null
}

function buildRestorableLoopTask(
  task: RestorableLoopBase,
  modeFields:
    | { loopMode: 'fixed'; cron: string }
    | { loopMode: 'dynamic'; nextFireAt: number },
): SessionCronTask {
  return {
    id: task.id,
    prompt: task.prompt,
    createdAt: task.createdAt,
    recurring: true,
    source: 'loop',
    ...modeFields,
    ...(typeof task.lastFiredAt === 'number'
      ? { lastFiredAt: task.lastFiredAt }
      : {}),
    ...(task.promptSource === 'explicit' || task.promptSource === 'maintenance'
      ? { promptSource: task.promptSource }
      : {}),
    ...(typeof task.lastDelayMinutes === 'number'
      ? { lastDelayMinutes: task.lastDelayMinutes }
      : {}),
    ...(typeof task.lastDelayReason === 'string'
      ? { lastDelayReason: task.lastDelayReason }
      : {}),
    ...(typeof task.agentId === 'string' ? { agentId: task.agentId } : {}),
  }
}

function isExpiredSessionTask(
  task: Pick<SessionCronTask, 'createdAt' | 'recurring' | 'source'>,
  now: number,
): boolean {
  if (!task.recurring || task.source !== 'loop') return false
  return now - task.createdAt >= SESSION_LOOP_MAX_AGE_MS
}
