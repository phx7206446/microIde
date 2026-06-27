import { writeFile } from 'fs/promises'
import type { LogOption } from '../types/logs.js'
import { errorMessage } from './errors.js'
import { loadTranscriptFromFile } from './sessionStorage.js'
import { generateTempFilePath } from './tempfile.js'

const DEFAULT_CCSHARE_BASE_URL = 'https://go/ccshare/'
const TRANSCRIPT_ACCEPT_HEADER =
  'application/x-ndjson, application/json, text/plain, text/html;q=0.9'

type DownloadedTranscript = {
  text: string
  extension: '.json' | '.jsonl'
  sourceUrl: string
}

function asUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function resolveUrl(value: string, baseUrl: string): URL | null {
  const absolute = asUrl(value)
  if (absolute) {
    return absolute
  }

  try {
    return new URL(value, baseUrl)
  } catch {
    return null
  }
}

export function parseCcshareId(input: string): string | null {
  const trimmed = input.trim()
  if (trimmed.length === 0) {
    return null
  }

  const normalized =
    /^go\//i.test(trimmed) && !/^https?:\/\//i.test(trimmed)
      ? `https://${trimmed}`
      : trimmed
  const parsed = asUrl(normalized)
  if (parsed) {
    const parts = parsed.pathname.split('/').filter(Boolean)
    const ccshareIndex = parts.findIndex(part => part === 'ccshare')
    if (ccshareIndex !== -1 && parts[ccshareIndex + 1]) {
      return decodeURIComponent(parts[ccshareIndex + 1]!)
    }
  }

  return /[\\/]/.test(trimmed) ? null : trimmed
}

function buildCandidateUrls(ccshareIdOrUrl: string): string[] {
  const normalized =
    /^go\//i.test(ccshareIdOrUrl) && !/^https?:\/\//i.test(ccshareIdOrUrl)
      ? `https://${ccshareIdOrUrl}`
      : ccshareIdOrUrl
  const baseUrl =
    asUrl(normalized) ??
    new URL(encodeURIComponent(ccshareIdOrUrl), DEFAULT_CCSHARE_BASE_URL)
  const candidates = new Set<string>([baseUrl.toString()])

  const pathname = baseUrl.pathname.toLowerCase()
  if (!pathname.endsWith('.json') && !pathname.endsWith('.jsonl')) {
    const withoutTrailingSlash = baseUrl.pathname.replace(/\/$/, '')
    candidates.add(new URL(`${withoutTrailingSlash}.jsonl`, baseUrl).toString())
    candidates.add(new URL(`${withoutTrailingSlash}.json`, baseUrl).toString())

    const downloadUrl = new URL(baseUrl)
    downloadUrl.pathname = `${withoutTrailingSlash}/download`
    candidates.add(downloadUrl.toString())

    const downloadJsonlUrl = new URL(downloadUrl)
    downloadJsonlUrl.pathname = `${downloadJsonlUrl.pathname}.jsonl`
    candidates.add(downloadJsonlUrl.toString())

    const queryJsonlUrl = new URL(baseUrl)
    queryJsonlUrl.searchParams.set('format', 'jsonl')
    candidates.add(queryJsonlUrl.toString())

    const queryDownloadUrl = new URL(baseUrl)
    queryDownloadUrl.searchParams.set('download', '1')
    candidates.add(queryDownloadUrl.toString())
  }

  return [...candidates]
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trim()
  return (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  )
}

function looksLikeJsonl(text: string): boolean {
  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
  if (lines.length === 0) {
    return false
  }

  for (const line of lines.slice(0, Math.min(lines.length, 5))) {
    try {
      const parsed = JSON.parse(line)
      if (typeof parsed !== 'object' || parsed === null) {
        return false
      }
    } catch {
      return false
    }
  }

  return true
}

function detectTranscriptFormat(
  text: string,
  contentType: string | null,
): '.json' | '.jsonl' | null {
  if (looksLikeJsonl(text)) {
    return '.jsonl'
  }
  if (looksLikeJson(text)) {
    return '.json'
  }

  const normalizedContentType = contentType?.toLowerCase() ?? ''
  if (normalizedContentType.includes('application/x-ndjson')) {
    return '.jsonl'
  }
  if (normalizedContentType.includes('application/json')) {
    return '.json'
  }
  return null
}

function extractTranscriptLinks(html: string, baseUrl: string): string[] {
  const discovered = new Set<string>()
  const patterns = [
    /(?:href|src|content|data-download-url)=["']([^"'#]+)["']/gi,
    /(https?:\/\/[^\s"'<>]+(?:download|transcript|jsonl?|ccshare)[^\s"'<>]*)/gi,
  ]

  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const raw = match[1]?.trim()
      if (!raw) {
        continue
      }

      const candidate = resolveUrl(raw, baseUrl)
      if (!candidate) {
        continue
      }

      const normalized = candidate.toString()
      if (
        normalized.includes('/ccshare/') ||
        normalized.includes('download') ||
        normalized.endsWith('.json') ||
        normalized.endsWith('.jsonl')
      ) {
        discovered.add(normalized)
      }
    }
  }

  return [...discovered]
}

async function fetchTranscript(
  url: string,
  seen: Set<string>,
  depth: number,
): Promise<DownloadedTranscript | null> {
  if (seen.has(url)) {
    return null
  }
  seen.add(url)

  let response: Response
  try {
    response = await fetch(url, {
      headers: {
        accept: TRANSCRIPT_ACCEPT_HEADER,
      },
    })
  } catch {
    return null
  }

  if (!response.ok) {
    return null
  }

  const text = await response.text()
  const format = detectTranscriptFormat(text, response.headers.get('content-type'))
  if (format) {
    return {
      text,
      extension: format,
      sourceUrl: response.url || url,
    }
  }

  if (depth <= 0) {
    return null
  }

  const isHtml =
    response.headers.get('content-type')?.toLowerCase().includes('text/html') ||
    text.toLowerCase().includes('<html')
  if (!isHtml) {
    return null
  }

  for (const nextUrl of extractTranscriptLinks(text, response.url || url)) {
    const downloaded = await fetchTranscript(nextUrl, seen, depth - 1)
    if (downloaded) {
      return downloaded
    }
  }

  return null
}

export async function loadCcshare(ccshareIdOrUrl: string): Promise<LogOption> {
  const seen = new Set<string>()
  let transcript: DownloadedTranscript | null = null

  for (const url of buildCandidateUrls(ccshareIdOrUrl)) {
    transcript = await fetchTranscript(url, seen, 2)
    if (transcript) {
      break
    }
  }

  if (!transcript) {
    const attempted = [...seen]
    const attemptsSuffix =
      attempted.length > 0 ? ` Tried: ${attempted.join(', ')}` : ''
    throw new Error(
      `Unable to download transcript for ccshare "${ccshareIdOrUrl}".${attemptsSuffix}`,
    )
  }

  const tempPath = generateTempFilePath('claude-ccshare', transcript.extension, {
    contentHash: transcript.text,
  })

  try {
    await writeFile(tempPath, transcript.text, 'utf8')
    return await loadTranscriptFromFile(tempPath)
  } catch (err) {
    throw new Error(
      `Failed to load ccshare transcript from ${transcript.sourceUrl}: ${errorMessage(err)}`,
    )
  }
}
