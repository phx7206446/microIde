import {
  lstat,
  readFile,
  readlink,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from 'fs/promises'
import { createInterface } from 'readline/promises'
import { stdin as input, stdout as output } from 'process'
import { join } from 'path'
import { getGlobalClaudeFile } from './env.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { getErrnoCode } from './errors.js'
import {
  type PersistedProjectState,
  getProjectTasksRoot,
  listKnownProjectStates,
  readProjectState,
} from './projectState.js'
import {
  type ProjectIdentity,
  getCurrentProjectIdentity,
  resolveProjectIdentityForPath,
} from './projectIdentity.js'
import { saveGlobalProjectConfigs } from './config.js'
import { jsonParse } from './slowOperations.js'

export type ProjectPurgeOptions = {
  all?: boolean
  dryRun?: boolean
  yes?: boolean
  interactive?: boolean
}

export type SingleProjectPurgePlan = {
  identity: ProjectIdentity
  state: PersistedProjectState
  projectDirExists: boolean
  tasksRootExists: boolean
  fileHistoryDirs: string[]
  debugFiles: string[]
  historyEntriesToRemove: number
  hasConfigEntry: boolean
}

export type ProjectPurgePlan =
  | {
      mode: 'all'
      knownProjects: PersistedProjectState[]
      removePaths: string[]
      existingRemovePaths: string[]
      hasHistoryFile: boolean
      projectConfigCount: number
    }
  | {
      mode: 'project'
      project: SingleProjectPurgePlan
    }

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    return getErrnoCode(error) !== 'ENOENT'
  }
}

async function countHistoryEntriesForProject(projectPath: string): Promise<number> {
  const historyPath = join(getClaudeConfigHomeDir(), 'history.jsonl')
  try {
    const raw = await readFile(historyPath, 'utf8')
    let count = 0
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const parsed = jsonParse(line) as { project?: unknown }
        if (parsed.project === projectPath) {
          count++
        }
      } catch {
        continue
      }
    }
    return count
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT') {
      return 0
    }
    throw error
  }
}

async function rewriteHistoryWithoutProject(projectPath: string): Promise<void> {
  const historyPath = join(getClaudeConfigHomeDir(), 'history.jsonl')
  let raw: string
  try {
    raw = await readFile(historyPath, 'utf8')
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT') {
      return
    }
    throw error
  }

  const kept: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const parsed = jsonParse(line) as { project?: unknown }
      if (parsed.project === projectPath) {
        continue
      }
    } catch {
      // Preserve malformed lines; purge should not silently destroy unknown data.
    }
    kept.push(line)
  }

  await writeFile(historyPath, kept.length > 0 ? `${kept.join('\n')}\n` : '')
}

function removeProjectConfigEntry(configKey: string): void {
  saveGlobalProjectConfigs(currentProjects => {
    if (!currentProjects?.[configKey]) {
      return currentProjects
    }
    const nextProjects = { ...currentProjects }
    delete nextProjects[configKey]
    return Object.keys(nextProjects).length > 0 ? nextProjects : undefined
  })
}

function clearAllProjectConfigEntries(): void {
  saveGlobalProjectConfigs(currentProjects =>
    currentProjects && Object.keys(currentProjects).length > 0
      ? undefined
      : currentProjects,
  )
}

async function chooseProjectIdentityInteractively(): Promise<ProjectIdentity | null> {
  const knownProjects = await listKnownProjectStates()
  const choices = new Map<string, ProjectIdentity>()

  for (const state of knownProjects) {
    const identity = resolveProjectIdentityForPath(state.projectPath)
    choices.set(identity.projectPath, identity)
  }

  const currentIdentity = getCurrentProjectIdentity()
  choices.set(currentIdentity.projectPath, currentIdentity)

  const ordered = Array.from(choices.values()).sort((a, b) =>
    a.displayName.localeCompare(b.displayName),
  )
  if (ordered.length === 0) {
    return null
  }

  const rl = createInterface({ input, output })
  try {
    output.write('Select a project to purge:\n')
    ordered.forEach((identity, index) => {
      output.write(`  ${index + 1}. ${identity.displayName}  ${identity.projectPath}\n`)
    })
    const answer = await rl.question('Project number (blank to cancel): ')
    const trimmed = answer.trim()
    if (!trimmed) {
      return null
    }
    const index = Number.parseInt(trimmed, 10)
    if (!Number.isInteger(index) || index < 1 || index > ordered.length) {
      throw new Error(`Invalid selection: ${answer}`)
    }
    return ordered[index - 1] ?? null
  } finally {
    rl.close()
  }
}

async function confirmExecution(message: string): Promise<boolean> {
  const rl = createInterface({ input, output })
  try {
    const answer = await rl.question(`${message} [y/N]: `)
    const normalized = answer.trim().toLowerCase()
    return normalized === 'y' || normalized === 'yes'
  } finally {
    rl.close()
  }
}

async function buildSingleProjectPlan(
  identity: ProjectIdentity,
): Promise<SingleProjectPurgePlan> {
  const state = await readProjectState(identity)
  const fileHistoryCandidates = state.sessionIds.map(sessionId =>
    join(getClaudeConfigHomeDir(), 'file-history', sessionId),
  )
  const debugCandidates = state.sessionIds.map(sessionId =>
    join(getClaudeConfigHomeDir(), 'debug', `${sessionId}.txt`),
  )
  const configRaw = await readFile(getGlobalClaudeFile(), 'utf8').catch(error => {
    if (getErrnoCode(error) === 'ENOENT') {
      return ''
    }
    throw error
  })
  const config = configRaw
    ? (jsonParse(configRaw) as { projects?: Record<string, unknown> })
    : {}

  const fileHistoryDirs = (
    await Promise.all(
      fileHistoryCandidates.map(async path => ((await pathExists(path)) ? path : null)),
    )
  ).filter((path): path is string => path !== null)
  const debugFiles = (
    await Promise.all(
      debugCandidates.map(async path => ((await pathExists(path)) ? path : null)),
    )
  ).filter((path): path is string => path !== null)

  return {
    identity,
    state,
    projectDirExists: await pathExists(identity.projectDir),
    tasksRootExists: await pathExists(getProjectTasksRoot(identity)),
    fileHistoryDirs,
    debugFiles,
    historyEntriesToRemove: await countHistoryEntriesForProject(identity.projectPath),
    hasConfigEntry: Boolean(config.projects?.[identity.configKey]),
  }
}

export async function buildProjectPurgePlan(
  targetPath: string | undefined,
  options: ProjectPurgeOptions,
): Promise<ProjectPurgePlan | null> {
  if (options.all) {
    const knownProjects = await listKnownProjectStates()
    const removePaths = [
      join(getClaudeConfigHomeDir(), 'projects'),
      join(getClaudeConfigHomeDir(), 'tasks'),
      join(getClaudeConfigHomeDir(), 'file-history'),
      join(getClaudeConfigHomeDir(), 'debug'),
    ]
    const existingRemovePaths = (
      await Promise.all(
        removePaths.map(async path => ((await pathExists(path)) ? path : null)),
      )
    ).filter((path): path is string => path !== null)
    const configRaw = await readFile(getGlobalClaudeFile(), 'utf8').catch(error => {
      if (getErrnoCode(error) === 'ENOENT') {
        return ''
      }
      throw error
    })
    const config = configRaw
      ? (jsonParse(configRaw) as { projects?: Record<string, unknown> })
      : {}

    return {
      mode: 'all',
      knownProjects,
      removePaths,
      existingRemovePaths,
      hasHistoryFile: await pathExists(join(getClaudeConfigHomeDir(), 'history.jsonl')),
      projectConfigCount: Object.keys(config.projects ?? {}).length,
    }
  }

  let identity: ProjectIdentity | null = null
  if (targetPath) {
    identity = resolveProjectIdentityForPath(targetPath)
  } else {
    identity = await chooseProjectIdentityInteractively()
  }

  if (!identity) {
    return null
  }

  return {
    mode: 'project',
    project: await buildSingleProjectPlan(identity),
  }
}

function printProjectPlan(plan: SingleProjectPurgePlan): void {
  const tasksRoot = getProjectTasksRoot(plan.identity)
  console.log(`Project: ${plan.identity.projectPath}`)
  console.log(`Project dir: ${plan.identity.projectDir}${plan.projectDirExists ? '' : ' (missing)'}`)
  console.log(`Tasks root: ${tasksRoot}${plan.tasksRootExists ? '' : ' (missing)'}`)
  console.log(`Indexed sessions: ${plan.state.sessionIds.length}`)
  console.log(`History entries to remove: ${plan.historyEntriesToRemove}`)
  console.log(`Project config entry: ${plan.hasConfigEntry ? 'yes' : 'no'}`)
}

function printAllPlan(plan: Extract<ProjectPurgePlan, { mode: 'all' }>): void {
  console.log('Purge all Claude project state')
  const existing = new Set(plan.existingRemovePaths)
  plan.removePaths.forEach(path =>
    console.log(`Remove: ${path}${existing.has(path) ? '' : ' (missing)'}`),
  )
  console.log(`Known indexed projects: ${plan.knownProjects.length}`)
  console.log(`Delete history.jsonl: ${plan.hasHistoryFile ? 'yes' : 'no'}`)
  console.log(`Project config entries: ${plan.projectConfigCount}`)
}

export function printProjectPurgePlan(plan: ProjectPurgePlan): void {
  if (plan.mode === 'all') {
    printAllPlan(plan)
    return
  }
  printProjectPlan(plan.project)
}

async function deleteIfExists(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true }).catch(async error => {
    if (getErrnoCode(error) === 'ENOTDIR') {
      await unlink(path).catch(innerError => {
        if (getErrnoCode(innerError) !== 'ENOENT') {
          throw innerError
        }
      })
      return
    }
    if (getErrnoCode(error) !== 'ENOENT') {
      throw error
    }
  })
}

async function pruneLatestDebugLink(): Promise<void> {
  const latestPath = join(getClaudeConfigHomeDir(), 'debug', 'latest')
  try {
    const stats = await lstat(latestPath)
    if (!stats.isSymbolicLink()) {
      return
    }
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT') {
      return
    }
  }

  try {
    const target = await readlink(latestPath)
    if (!(await pathExists(target))) {
      await unlink(latestPath)
    }
  } catch {
    await unlink(latestPath).catch(() => {})
  }
}

async function executeSingleProjectPurge(plan: SingleProjectPurgePlan): Promise<void> {
  await rewriteHistoryWithoutProject(plan.identity.projectPath)
  removeProjectConfigEntry(plan.identity.configKey)
  await deleteIfExists(plan.identity.projectDir)
  await deleteIfExists(getProjectTasksRoot(plan.identity))
  await Promise.all(plan.fileHistoryDirs.map(deleteIfExists))
  await Promise.all(plan.debugFiles.map(deleteIfExists))
  await pruneLatestDebugLink()
}

async function executeAllProjectPurge(
  plan: Extract<ProjectPurgePlan, { mode: 'all' }>,
): Promise<void> {
  for (const path of plan.removePaths) {
    await deleteIfExists(path)
  }
  await deleteIfExists(join(getClaudeConfigHomeDir(), 'history.jsonl'))
  clearAllProjectConfigEntries()
}

export async function runProjectPurge(
  targetPath: string | undefined,
  options: ProjectPurgeOptions,
): Promise<'ok' | 'not_found' | 'cancelled'> {
  const plan = await buildProjectPurgePlan(targetPath, options)
  if (!plan) {
    return 'cancelled'
  }

  printProjectPurgePlan(plan)

  if (plan.mode === 'project') {
    const matches =
      Number(plan.project.projectDirExists) +
      Number(plan.project.tasksRootExists) +
      plan.project.fileHistoryDirs.length +
      plan.project.debugFiles.length +
      Number(plan.project.historyEntriesToRemove > 0) +
      Number(plan.project.hasConfigEntry)
    if (matches === 0) {
      return 'not_found'
    }
  } else {
    const matches =
      plan.existingRemovePaths.length +
      Number(plan.hasHistoryFile) +
      Number(plan.projectConfigCount > 0)
    if (matches === 0) {
      return 'not_found'
    }
  }

  if (options.dryRun) {
    return 'ok'
  }

  if (!options.yes || options.interactive) {
    const confirmed = await confirmExecution(
      plan.mode === 'all'
        ? 'Delete all project-scoped Claude state?'
        : `Delete project-scoped Claude state for ${plan.project.identity.displayName}?`,
    )
    if (!confirmed) {
      return 'cancelled'
    }
  }

  if (plan.mode === 'all') {
    await executeAllProjectPurge(plan)
  } else {
    await executeSingleProjectPurge(plan.project)
  }
  return 'ok'
}
