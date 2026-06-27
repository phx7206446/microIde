import axios from 'axios'
import { createHash } from 'crypto'
import { writeFile } from 'fs/promises'
import { basename, join } from 'path'
import type { PluginError } from '../../types/plugin.js'
import { registerCleanup } from '../cleanupRegistry.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import { getFsImplementation } from '../fsOperations.js'
import {
  cleanupSessionPluginCache,
  getSessionPluginCachePath,
} from './zipCache.js'

function redactUrlCredentials(urlString: string): string {
  try {
    const parsed = new URL(urlString)
    const isHttp = parsed.protocol === 'http:' || parsed.protocol === 'https:'
    if (isHttp && (parsed.username || parsed.password)) {
      if (parsed.username) parsed.username = '***'
      if (parsed.password) parsed.password = '***'
      return parsed.toString()
    }
  } catch {
    // Not a valid URL; return as-is for the caller's validation error.
  }
  return urlString
}

function getDownloadFileName(url: string, index: number): string {
  const hash = createHash('sha256').update(url).digest('hex').slice(0, 16)

  let baseName = 'plugin'
  try {
    const parsed = new URL(url)
    const lastSegment = basename(parsed.pathname)
    if (lastSegment) {
      baseName = lastSegment.replace(/\.zip$/i, '') || 'plugin'
    }
  } catch {
    // Ignore parse failure; validation happens elsewhere.
  }

  const safeBaseName = baseName.replace(/[^a-zA-Z0-9\-_]/g, '-') || 'plugin'
  return `inline-url-${index}-${safeBaseName}-${hash}.zip`
}

export async function downloadSessionPluginsFromUrls(
  urls: string[],
): Promise<{ pluginPaths: string[]; errors: PluginError[] }> {
  if (urls.length === 0) {
    return { pluginPaths: [], errors: [] }
  }

  registerCleanup(cleanupSessionPluginCache)
  const sessionDir = await getSessionPluginCachePath()
  const downloadDir = join(sessionDir, 'downloads')
  await getFsImplementation().mkdir(downloadDir)

  const pluginPaths: string[] = []
  const errors: PluginError[] = []

  for (const [index, url] of urls.entries()) {
    const source = `inline-url[${index}]`
    const redactedUrl = redactUrlCredentials(url)

    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Plugin URL must use http:// or https://')
      }

      logForDebugging(
        `Downloading session-only plugin ZIP from ${redactedUrl}`,
      )
      const response = await axios.get<ArrayBuffer>(url, {
        responseType: 'arraybuffer',
        timeout: 15000,
        maxRedirects: 5,
        headers: {
          'User-Agent': 'Claude-Code-Session-Plugin',
        },
      })

      const downloadPath = join(downloadDir, getDownloadFileName(url, index))
      await writeFile(downloadPath, Buffer.from(response.data))
      pluginPaths.push(downloadPath)
    } catch (error) {
      const details = errorMessage(error)
      logForDebugging(
        `Failed to download session-only plugin ZIP from ${redactedUrl}: ${details}`,
        { level: 'warn' },
      )
      errors.push({
        type: 'network-error',
        source,
        url: redactedUrl,
        details,
      })
    }
  }

  return { pluginPaths, errors }
}
