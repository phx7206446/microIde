import { realpathSync } from 'fs'
import memoize from 'lodash-es/memoize.js'
import { basename, join, resolve } from 'path'
import { getProjectRoot } from '../bootstrap/state.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { findCanonicalGitRoot } from './git.js'
import { normalizePathForConfigKey, sanitizePath } from './path.js'

export type ProjectIdentity = {
  projectPath: string
  configKey: string
  slug: string
  projectDir: string
  displayName: string
}

function normalizeProjectPath(path: string): string {
  return path.normalize('NFC')
}

function canonicalizeProjectPath(path: string): string {
  const resolved = resolve(path)
  const gitRoot = findCanonicalGitRoot(resolved)
  if (gitRoot) {
    return normalizeProjectPath(gitRoot)
  }

  try {
    return normalizeProjectPath(realpathSync(resolved))
  } catch {
    return normalizeProjectPath(resolved)
  }
}

function buildProjectIdentity(projectPath: string): ProjectIdentity {
  const normalizedProjectPath = canonicalizeProjectPath(projectPath)
  return {
    projectPath: normalizedProjectPath,
    configKey: normalizePathForConfigKey(normalizedProjectPath),
    slug: sanitizePath(normalizedProjectPath),
    projectDir: join(getClaudeConfigHomeDir(), 'projects', sanitizePath(normalizedProjectPath)),
    displayName: basename(normalizedProjectPath) || normalizedProjectPath,
  }
}

export const resolveProjectIdentityForPath = memoize(
  (projectPath: string): ProjectIdentity => buildProjectIdentity(projectPath),
)

export function getCurrentProjectIdentity(): ProjectIdentity {
  return buildProjectIdentity(getProjectRoot())
}

export function getCurrentProjectPath(): string {
  return getCurrentProjectIdentity().projectPath
}

export function getCurrentProjectConfigKey(): string {
  return getCurrentProjectIdentity().configKey
}

export function getCurrentProjectDir(): string {
  return getCurrentProjectIdentity().projectDir
}

export function getProjectDirForPath(projectPath: string): string {
  return resolveProjectIdentityForPath(projectPath).projectDir
}
