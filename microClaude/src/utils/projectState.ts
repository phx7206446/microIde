import { mkdir, readdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import * as lockfile from './lockfile.js'
import { getSessionId } from '../bootstrap/state.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { getErrnoCode } from './errors.js'
import { getFsImplementation } from './fsOperations.js'
import { jsonParse, jsonStringify } from './slowOperations.js'
import {
  type ProjectIdentity,
  getCurrentProjectIdentity,
  resolveProjectIdentityForPath,
} from './projectIdentity.js'

const PROJECT_STATE_FILE = '.project-state.json'
const LOCK_OPTIONS = {
  retries: {
    retries: 10,
    minTimeout: 10,
    maxTimeout: 100,
  },
}

export type PersistedProjectState = {
  version: 1
  projectPath: string
  configKey: string
  slug: string
  createdAt: string
  updatedAt: string
  sessionIds: string[]
  taskListIds: string[]
}

function createDefaultProjectState(
  identity: ProjectIdentity,
): PersistedProjectState {
  const now = new Date().toISOString()
  return {
    version: 1,
    projectPath: identity.projectPath,
    configKey: identity.configKey,
    slug: identity.slug,
    createdAt: now,
    updatedAt: now,
    sessionIds: [],
    taskListIds: [],
  }
}

export function getProjectStatePath(
  identity: ProjectIdentity = getCurrentProjectIdentity(),
): string {
  return join(identity.projectDir, PROJECT_STATE_FILE)
}

function normalizeProjectState(
  identity: ProjectIdentity,
  value: unknown,
): PersistedProjectState {
  const fallback = createDefaultProjectState(identity)
  if (!value || typeof value !== 'object') {
    return fallback
  }

  const candidate = value as Partial<PersistedProjectState>
  return {
    version: 1,
    projectPath: identity.projectPath,
    configKey: identity.configKey,
    slug: identity.slug,
    createdAt:
      typeof candidate.createdAt === 'string'
        ? candidate.createdAt
        : fallback.createdAt,
    updatedAt:
      typeof candidate.updatedAt === 'string'
        ? candidate.updatedAt
        : fallback.updatedAt,
    sessionIds: Array.isArray(candidate.sessionIds)
      ? candidate.sessionIds.filter(
          (sessionId): sessionId is string => typeof sessionId === 'string',
        )
      : [],
    taskListIds: Array.isArray(candidate.taskListIds)
      ? candidate.taskListIds.filter(
          (taskListId): taskListId is string => typeof taskListId === 'string',
        )
      : [],
  }
}

export async function readProjectState(
  identity: ProjectIdentity = getCurrentProjectIdentity(),
): Promise<PersistedProjectState> {
  const statePath = getProjectStatePath(identity)

  try {
    const raw = await readFile(statePath, 'utf8')
    return normalizeProjectState(identity, jsonParse(raw))
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT') {
      return createDefaultProjectState(identity)
    }
    throw error
  }
}

async function writeProjectState(
  identity: ProjectIdentity,
  state: PersistedProjectState,
): Promise<void> {
  await mkdir(identity.projectDir, { recursive: true, mode: 0o700 })
  await writeFile(getProjectStatePath(identity), jsonStringify(state, null, 2))
}

export async function updateProjectState(
  updater: (current: PersistedProjectState) => PersistedProjectState,
  identity: ProjectIdentity = getCurrentProjectIdentity(),
): Promise<PersistedProjectState> {
  const lockPath = `${getProjectStatePath(identity)}.lock`
  await mkdir(identity.projectDir, { recursive: true, mode: 0o700 })
  await writeFile(lockPath, '', { flag: 'a' })

  const release = await lockfile.lock(lockPath, LOCK_OPTIONS)
  try {
    const current = await readProjectState(identity)
    const updated = updater(current)
    const normalized = {
      ...updated,
      version: 1 as const,
      projectPath: identity.projectPath,
      configKey: identity.configKey,
      slug: identity.slug,
      updatedAt: new Date().toISOString(),
    }
    await writeProjectState(identity, normalized)
    return normalized
  } finally {
    await release()
  }
}

export async function registerProjectSession(
  sessionId: string = getSessionId(),
  identity: ProjectIdentity = getCurrentProjectIdentity(),
): Promise<void> {
  await updateProjectState(current => {
    if (current.sessionIds.includes(sessionId)) {
      return current
    }
    return {
      ...current,
      sessionIds: [...current.sessionIds, sessionId],
    }
  }, identity)
}

export async function registerProjectTaskList(
  taskListId: string,
  identity: ProjectIdentity = getCurrentProjectIdentity(),
): Promise<void> {
  await updateProjectState(current => {
    if (current.taskListIds.includes(taskListId)) {
      return current
    }
    return {
      ...current,
      taskListIds: [...current.taskListIds, taskListId],
    }
  }, identity)
}

export function getProjectTasksRoot(
  identity: ProjectIdentity = getCurrentProjectIdentity(),
): string {
  return join(getClaudeConfigHomeDir(), 'tasks', identity.slug)
}

export function getProjectTaskListDir(
  taskListId: string,
  identity: ProjectIdentity = getCurrentProjectIdentity(),
): string {
  return join(getProjectTasksRoot(identity), taskListId)
}

export async function listKnownProjectStates(): Promise<PersistedProjectState[]> {
  const projectsDir = join(getClaudeConfigHomeDir(), 'projects')
  let dirents
  try {
    dirents = await readdir(projectsDir, { withFileTypes: true })
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT') {
      return []
    }
    throw error
  }

  const states: PersistedProjectState[] = []
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue
    const statePath = join(projectsDir, dirent.name, PROJECT_STATE_FILE)
    try {
      const raw = await readFile(statePath, 'utf8')
      const parsed = jsonParse(raw) as Partial<PersistedProjectState>
      if (typeof parsed.projectPath !== 'string') continue
      states.push(
        normalizeProjectState(
          resolveProjectIdentityForPath(parsed.projectPath),
          parsed,
        ),
      )
    } catch (error) {
      if (getErrnoCode(error) === 'ENOENT') {
        continue
      }
      throw error
    }
  }

  return states
}

export async function projectStateExists(
  identity: ProjectIdentity = getCurrentProjectIdentity(),
): Promise<boolean> {
  try {
    await getFsImplementation().stat(getProjectStatePath(identity))
    return true
  } catch (error) {
    return getErrnoCode(error) !== 'ENOENT'
  }
}
