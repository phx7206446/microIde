import { mkdir, readFile, stat, writeFile } from 'fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'path'
import { setOriginalCwd } from '../bootstrap/state.js'
import type { ToolUseContext } from '../Tool.js'
import { FILE_EDIT_TOOL_NAME } from '../tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../tools/FileWriteTool/prompt.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../tools/NotebookEditTool/constants.js'
import { clearMemoryFileCaches } from './claudemd.js'
import { clearSystemPromptSections } from '../constants/systemPromptSections.js'
import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { findCanonicalGitRoot, findGitRoot } from './git.js'
import { hasWorktreeCreateHook } from './hooks.js'
import { safeParseJSON } from './json.js'
import { getPlansDirectory } from './plans.js'
import { saveWorktreeState } from './sessionStorage.js'
import { setCwd } from './Shell.js'
import { jsonStringify } from './slowOperations.js'
import { updateHooksConfigSnapshot } from './hooks/hooksConfigSnapshot.js'
import {
  createAgentWorktree,
  getCurrentWorktreeSession,
  restoreWorktreeSession,
  type WorktreeSession,
} from './worktree.js'

type AgentViewWorktreeState = {
  id: string
  sessionId: string
  cwd: string
  rootCwd: string
  updatedAt: number
  worktreePath?: string
  worktreeBranch?: string
  worktreeHeadCommit?: string
  worktreeGitRoot?: string
  worktreeHookBased?: boolean
  worktreeRemovedAt?: number
}

type RewriteResult = {
  input: unknown
  effectiveCwd?: string
  displayInput?: unknown
}

type WorktreeInfo = {
  worktreePath: string
  worktreeBranch?: string
  headCommit?: string
  gitRoot?: string
  hookBased?: boolean
}

type AgentViewWritablePathMapping = {
  originalPath: string
  worktreePath: string
}

const AGENT_VIEW_JOB_ID_ENV = 'CLAUDE_CODE_AGENT_VIEW_JOB_ID'
const AGENT_VIEW_JOB_STATE_ENV = 'CLAUDE_CODE_AGENT_VIEW_STATE_PATH'
const originalPathByWorktreePath = new Map<string, AgentViewWritablePathMapping>()

function normalizePath(path: string): string {
  return resolve(path).normalize('NFC')
}

function isPathInsideOrEqual(path: string, parent: string): boolean {
  const rel = relative(normalizePath(parent), normalizePath(path))
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel))
}

function resolveAgainst(path: string, base: string): string {
  return normalizePath(isAbsolute(path) ? path : join(base, path))
}

function pathRelativeTo(path: string, parent: string): string | null {
  const rel = relative(normalizePath(parent), normalizePath(path))
  if (rel === '') return ''
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  return rel
}

async function pathIsDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

function isClaudeWorktreePath(path: string): boolean {
  const parts = normalizePath(path).split(/[\\/]+/)
  return parts.some(
    (part, index) =>
      part === '.claude' &&
      parts[index + 1] === 'worktrees' &&
      Boolean(parts[index + 2]),
  )
}

function isAlreadyUnderClaudeWorktrees(
  state: AgentViewWorktreeState,
  currentCwd: string,
): boolean {
  if (
    isClaudeWorktreePath(state.rootCwd) ||
    isClaudeWorktreePath(state.cwd) ||
    isClaudeWorktreePath(currentCwd)
  ) {
    return true
  }

  const gitRoot = findGitRoot(state.rootCwd)
  if (!gitRoot) return false
  if (isClaudeWorktreePath(gitRoot)) return true

  const canonicalRoot = findCanonicalGitRoot(state.rootCwd)
  if (!canonicalRoot) return false
  return isPathInsideOrEqual(
    gitRoot,
    join(canonicalRoot, '.claude', 'worktrees'),
  )
}

function relativeValue(from: string, to: string): string {
  const rel = relative(normalizePath(from), normalizePath(to))
  return rel === '' ? '.' : rel
}

function originalWorktreeBase(
  state: AgentViewWorktreeState,
  worktree: WorktreeInfo,
): string {
  return worktree.gitRoot ?? state.rootCwd
}

function mapOriginalPathToWorktree(
  state: AgentViewWorktreeState,
  worktree: WorktreeInfo,
  originalPath: string,
): string | null {
  const relativePath = pathRelativeTo(
    originalPath,
    originalWorktreeBase(state, worktree),
  )
  if (relativePath === null) return null
  return normalizePath(join(worktree.worktreePath, relativePath))
}

function getWritablePathKey(toolName: string): 'file_path' | 'notebook_path' | null {
  if (toolName === FILE_EDIT_TOOL_NAME || toolName === FILE_WRITE_TOOL_NAME) {
    return 'file_path'
  }
  if (toolName === NOTEBOOK_EDIT_TOOL_NAME) return 'notebook_path'
  return null
}

function getJobStatePath(): string | null {
  const statePath = process.env[AGENT_VIEW_JOB_STATE_ENV]
  if (statePath) return statePath
  const id = process.env[AGENT_VIEW_JOB_ID_ENV]
  return id ? join(getClaudeConfigHomeDir(), 'jobs', id, 'state.json') : null
}

async function readAgentViewState(): Promise<AgentViewWorktreeState | null> {
  const statePath = getJobStatePath()
  if (!statePath) return null
  try {
    const parsed = safeParseJSON(await readFile(statePath, 'utf8'), false) as
      | Partial<AgentViewWorktreeState>
      | null
    if (
      !parsed ||
      typeof parsed.id !== 'string' ||
      typeof parsed.sessionId !== 'string' ||
      typeof parsed.cwd !== 'string' ||
      typeof parsed.rootCwd !== 'string' ||
      typeof parsed.updatedAt !== 'number'
    ) {
      return null
    }
    return {
      ...parsed,
      id: parsed.id,
      sessionId: parsed.sessionId,
      cwd: parsed.cwd,
      rootCwd: parsed.rootCwd,
      updatedAt: parsed.updatedAt,
    }
  } catch {
    return null
  }
}

async function patchAgentViewState(
  patch: Partial<AgentViewWorktreeState>,
): Promise<void> {
  const statePath = getJobStatePath()
  if (!statePath) return
  const current = await readAgentViewState()
  if (!current) return
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 })
  await writeFile(
    statePath,
    `${jsonStringify({ ...current, ...patch, updatedAt: Date.now() }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  )
}

async function patchAgentViewWorktreeState(
  state: AgentViewWorktreeState,
  worktree: WorktreeInfo,
  patch: Partial<AgentViewWorktreeState> = {},
): Promise<void> {
  await patchAgentViewState({
    worktreePath: worktree.worktreePath,
    worktreeBranch: worktree.worktreeBranch,
    worktreeHeadCommit: worktree.headCommit,
    worktreeGitRoot: worktree.gitRoot,
    worktreeHookBased: worktree.hookBased,
    worktreeRemovedAt: undefined,
    ...patch,
  })
}

function makeAgentViewSlug(jobId: string): string {
  return `agentview-${jobId.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 32)}`
}

function cloneReadStateForWorktree(
  toolUseContext: ToolUseContext,
  sourcePath: string,
  targetPath: string,
): void {
  if (toolUseContext.readFileState.has(targetPath)) return
  const source = toolUseContext.readFileState.get(sourcePath)
  if (!source) return
  toolUseContext.readFileState.set(targetPath, source)
}

async function mirrorReadStateToOriginal(
  toolUseContext: ToolUseContext,
  worktreePath: string,
): Promise<void> {
  const mapping = originalPathByWorktreePath.get(normalizePath(worktreePath))
  if (!mapping) return
  const current = toolUseContext.readFileState.get(mapping.worktreePath)
  if (!current) return
  toolUseContext.readFileState.set(mapping.originalPath, current)
}

async function ensureAgentViewWorktree(
  state: AgentViewWorktreeState,
  currentCwd: string,
): Promise<WorktreeInfo | null> {
  let shouldPreserveExistingBranch = false
  if (state.worktreePath && !state.worktreeRemovedAt) {
    if (!(await pathIsDirectory(state.worktreePath))) {
      logForDebugging(
        `Agent View worktree ${state.worktreePath} no longer exists; recreating before next write`,
        { level: 'warn' },
      )
      shouldPreserveExistingBranch = true
      await patchAgentViewState({
        worktreePath: undefined,
        worktreeBranch: undefined,
        worktreeHeadCommit: undefined,
        worktreeGitRoot: undefined,
        worktreeHookBased: undefined,
        worktreeRemovedAt: Date.now(),
      })
    } else {
      return {
        worktreePath: state.worktreePath,
        worktreeBranch: state.worktreeBranch,
        headCommit: state.worktreeHeadCommit,
        gitRoot: state.worktreeGitRoot,
        hookBased: state.worktreeHookBased,
      }
    }
  }

  if (getCurrentWorktreeSession()) return null
  if (isAlreadyUnderClaudeWorktrees(state, currentCwd)) return null
  if (!findGitRoot(state.rootCwd) && !hasWorktreeCreateHook()) return null

  const worktree = await createAgentWorktree(makeAgentViewSlug(state.id), {
    baseCwd: state.rootCwd,
    preserveExistingBranch: shouldPreserveExistingBranch,
    pruneBeforeCreate: shouldPreserveExistingBranch,
  })
  await patchAgentViewWorktreeState(state, worktree)
  return worktree
}

function enterAgentViewWorktreeSession(
  state: AgentViewWorktreeState,
  worktree: WorktreeInfo,
  cwd: string,
): void {
  const sessionCwd = isPathInsideOrEqual(cwd, worktree.worktreePath)
    ? cwd
    : worktree.worktreePath
  process.chdir(sessionCwd)
  setCwd(sessionCwd)
  setOriginalCwd(sessionCwd)
  const worktreeSession = {
    originalCwd: state.rootCwd,
    worktreePath: worktree.worktreePath,
    worktreeName: makeAgentViewSlug(state.id),
    worktreeBranch: worktree.worktreeBranch,
    originalHeadCommit: worktree.headCommit,
    sessionId: state.sessionId,
    hookBased: worktree.hookBased,
  } satisfies WorktreeSession
  restoreWorktreeSession(worktreeSession)
  saveWorktreeState(worktreeSession)
  clearSystemPromptSections()
  clearMemoryFileCaches()
  getPlansDirectory.cache.clear?.()
  updateHooksConfigSnapshot()
}

export function isAgentViewBackgroundSession(): boolean {
  return (
    process.env.CLAUDE_CODE_SESSION_KIND === 'bg' &&
    Boolean(process.env[AGENT_VIEW_JOB_ID_ENV] || process.env[AGENT_VIEW_JOB_STATE_ENV])
  )
}

export async function prepareAgentViewWritableToolInput(
  toolName: string,
  input: unknown,
  toolUseContext: ToolUseContext,
): Promise<RewriteResult> {
  if (!isAgentViewBackgroundSession()) return { input }
  if (!input || typeof input !== 'object') return { input }

  const pathKey = getWritablePathKey(toolName)
  if (!pathKey) return { input }

  const record = input as Record<string, unknown>
  const originalValue = record[pathKey]
  if (typeof originalValue !== 'string' || originalValue.trim() === '') {
    return { input }
  }

  const state = await readAgentViewState()
  if (!state) return { input }

  const currentCwd = getCwd()
  const resolvedPath = resolveAgainst(originalValue, currentCwd)
  if (
    state.worktreePath &&
    !state.worktreeRemovedAt &&
    isPathInsideOrEqual(resolvedPath, state.worktreePath)
  ) {
    const worktree = await ensureAgentViewWorktree(state, currentCwd)
    if (worktree && !isPathInsideOrEqual(getCwd(), worktree.worktreePath)) {
      enterAgentViewWorktreeSession(state, worktree, worktree.worktreePath)
      await patchAgentViewWorktreeState(state, worktree, {
        cwd: getCwd(),
      })
      return { input, effectiveCwd: getCwd() }
    }
    return { input }
  }
  if (!isPathInsideOrEqual(resolvedPath, state.rootCwd)) {
    return { input }
  }

  const worktree = await ensureAgentViewWorktree(state, currentCwd)
  if (!worktree) return { input }

  if (!isPathInsideOrEqual(getCwd(), worktree.worktreePath)) {
    logForDebugging(
      `Agent View background session ${state.id} entering lazy worktree ${worktree.worktreePath}`,
    )
    const nextCwd =
      mapOriginalPathToWorktree(state, worktree, currentCwd) ??
      worktree.worktreePath
    enterAgentViewWorktreeSession(state, worktree, nextCwd)
    await patchAgentViewWorktreeState(state, worktree, {
      cwd: getCwd(),
    })
  }

  const rewrittenPath = mapOriginalPathToWorktree(state, worktree, resolvedPath)
  if (rewrittenPath === null) return { input, effectiveCwd: getCwd() }
  cloneReadStateForWorktree(toolUseContext, resolvedPath, rewrittenPath)
  originalPathByWorktreePath.set(rewrittenPath, {
    originalPath: resolvedPath,
    worktreePath: rewrittenPath,
  })
  return {
    input: {
      ...record,
      [pathKey]: isAbsolute(originalValue)
        ? rewrittenPath
        : relativeValue(getCwd(), rewrittenPath),
    },
    displayInput: record,
    effectiveCwd: getCwd(),
  }
}

export async function finalizeAgentViewWritableToolInput(
  input: unknown,
  toolUseContext: ToolUseContext,
): Promise<void> {
  if (!isAgentViewBackgroundSession()) return
  if (!input || typeof input !== 'object') return
  const record = input as Record<string, unknown>
  const pathValue =
    typeof record.file_path === 'string'
      ? record.file_path
      : typeof record.notebook_path === 'string'
        ? record.notebook_path
        : undefined
  if (!pathValue) return
  await mirrorReadStateToOriginal(
    toolUseContext,
    resolveAgainst(pathValue, getCwd()),
  )
}
