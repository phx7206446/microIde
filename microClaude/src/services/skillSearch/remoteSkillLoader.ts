import { createHash } from 'crypto'
import {
  cp,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from 'fs/promises'
import { basename, isAbsolute, join } from 'path'
import { fileURLToPath } from 'url'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'

export type RemoteSkillFetchMethod = 'cache' | 'local' | 'network'

export type RemoteSkillLoadResult = {
  cacheHit: boolean
  latencyMs: number
  skillPath: string
  content: string
  fileCount: number
  totalBytes: number
  fetchMethod: RemoteSkillFetchMethod
}

function getRemoteSkillCacheDir(slug: string, url: string): string {
  const urlHash = createHash('sha256').update(url).digest('hex').slice(0, 12)
  return join(
    getClaudeConfigHomeDir(),
    'cache',
    'remote-skills',
    `${slug}-${urlHash}`,
  )
}

async function countFiles(root: string): Promise<number> {
  const entries = await readdir(root, { withFileTypes: true })
  let count = 0
  for (const entry of entries) {
    const childPath = join(root, entry.name)
    if (entry.isDirectory()) {
      count += await countFiles(childPath)
      continue
    }
    count += 1
  }
  return count
}

async function ensureCacheDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

async function tryReadCachedSkill(
  cacheDir: string,
  skillPath: string,
): Promise<RemoteSkillLoadResult | null> {
  try {
    const content = await readFile(skillPath, 'utf8')
    return {
      cacheHit: true,
      latencyMs: 0,
      skillPath,
      content,
      fileCount: await countFiles(cacheDir),
      totalBytes: Buffer.byteLength(content),
      fetchMethod: 'cache',
    }
  } catch {
    return null
  }
}

function resolveLocalPath(url: string): string | null {
  if (url.startsWith('file://')) {
    return fileURLToPath(url)
  }
  if (isAbsolute(url)) {
    return url
  }
  return null
}

function resolveHttpUrl(url: string): string {
  if (url.startsWith('gs://')) {
    const path = url.slice('gs://'.length)
    return `https://storage.googleapis.com/${path}`
  }
  if (url.startsWith('s3://')) {
    const path = url.slice('s3://'.length)
    const slashIndex = path.indexOf('/')
    if (slashIndex === -1) {
      return `https://${path}.s3.amazonaws.com/SKILL.md`
    }
    const bucket = path.slice(0, slashIndex)
    const key = path.slice(slashIndex + 1)
    return `https://${bucket}.s3.amazonaws.com/${key}`
  }
  return url
}

function resolveRemoteSkillFileUrl(url: string): string {
  const resolved = resolveHttpUrl(url)
  if (/\.[a-z0-9]+$/i.test(basename(resolved))) {
    return resolved
  }
  return resolved.endsWith('/') ? `${resolved}SKILL.md` : `${resolved}/SKILL.md`
}

async function copyLocalSkill(
  sourcePath: string,
  cacheDir: string,
): Promise<RemoteSkillLoadResult> {
  const start = Date.now()
  const info = await stat(sourcePath)

  if (info.isDirectory()) {
    await ensureCacheDir(cacheDir)
    await cp(sourcePath, cacheDir, { recursive: true, force: true })
    const skillPath = join(cacheDir, 'SKILL.md')
    const content = await readFile(skillPath, 'utf8')
    return {
      cacheHit: false,
      latencyMs: Date.now() - start,
      skillPath,
      content,
      fileCount: await countFiles(cacheDir),
      totalBytes: Buffer.byteLength(content),
      fetchMethod: 'local',
    }
  }

  await ensureCacheDir(cacheDir)
  const skillPath = join(cacheDir, 'SKILL.md')
  const content = await readFile(sourcePath, 'utf8')
  await writeFile(skillPath, content, 'utf8')
  return {
    cacheHit: false,
    latencyMs: Date.now() - start,
    skillPath,
    content,
    fileCount: 1,
    totalBytes: Buffer.byteLength(content),
    fetchMethod: 'local',
  }
}

async function fetchRemoteSkill(
  url: string,
  cacheDir: string,
): Promise<RemoteSkillLoadResult> {
  const start = Date.now()
  const skillUrl = resolveRemoteSkillFileUrl(url)
  const response = await fetch(skillUrl, {
    headers: { 'User-Agent': 'Claude-Code-SkillLoader' },
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while loading ${skillUrl}`)
  }

  const content = await response.text()
  await ensureCacheDir(cacheDir)
  const skillPath = join(cacheDir, 'SKILL.md')
  await writeFile(skillPath, content, 'utf8')
  return {
    cacheHit: false,
    latencyMs: Date.now() - start,
    skillPath,
    content,
    fileCount: 1,
    totalBytes: Buffer.byteLength(content),
    fetchMethod: 'network',
  }
}

export async function loadRemoteSkill(
  slug: string,
  url: string,
): Promise<RemoteSkillLoadResult> {
  const cacheDir = getRemoteSkillCacheDir(slug, url)
  const cachedSkillPath = join(cacheDir, 'SKILL.md')
  const cached = await tryReadCachedSkill(cacheDir, cachedSkillPath)
  if (cached) {
    return cached
  }

  const localPath = resolveLocalPath(url)
  if (localPath) {
    return copyLocalSkill(localPath, cacheDir)
  }

  return fetchRemoteSkill(url, cacheDir)
}
