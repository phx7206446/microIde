import { feature } from 'bun:bundle'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import { getDefaultSonnetModel } from '../utils/model/model.js'
import { sideQuery } from '../utils/sideQuery.js'
import { jsonParse } from '../utils/slowOperations.js'
import {
  formatMemoryManifest,
  type MemoryHeader,
  scanMemoryFiles,
} from './memoryScan.js'

export type RelevantMemory = {
  path: string
  mtimeMs: number
}

const SELECT_MEMORIES_SYSTEM_PROMPT = `You are selecting memories that will be useful to Claude Code as it processes a user's query. You will be given the user's query and a list of available memory files with their filenames and descriptions.

Return a list of filenames for the memories that will clearly be useful to Claude Code as it processes the user's query (up to 5). Only include memories that you are certain will be helpful based on their name and description.
- If you are unsure if a memory will be useful in processing the user's query, then do not include it in your list. Be selective and discerning.
- If there are no memories in the list that would clearly be useful, feel free to return an empty list.
- If a list of recently-used tools is provided, do not select memories that are usage reference or API documentation for those tools (Claude Code is already exercising them). DO still select memories containing warnings, gotchas, or known issues about those tools — active use is exactly when those matter.
`

/**
 * Find memory files relevant to a query by scanning memory file headers
 * and asking Sonnet to select the most relevant ones.
 *
 * Returns absolute file paths + mtime of the most relevant memories
 * (up to 5). Excludes MEMORY.md (already loaded in system prompt).
 * mtime is threaded through so callers can surface freshness to the
 * main model without a second stat.
 *
 * `alreadySurfaced` filters paths shown in prior turns before the
 * Sonnet call, so the selector spends its 5-slot budget on fresh
 * candidates instead of re-picking files the caller will discard.
 */
export async function findRelevantMemories(
  query: string,
  memoryDir: string,
  signal: AbortSignal,
  recentTools: readonly string[] = [],
  alreadySurfaced: ReadonlySet<string> = new Set(),
): Promise<RelevantMemory[]> {
  const memories = (await scanMemoryFiles(memoryDir, signal)).filter(
    m => !alreadySurfaced.has(m.filePath),
  )
  if (memories.length === 0) {
    return []
  }

  const selectedFilenames = await selectRelevantMemories(
    query,
    memories,
    signal,
    recentTools,
  )
  const byFilename = new Map(memories.map(m => [m.filename, m]))
  const selected = selectedFilenames
    .map(filename => byFilename.get(filename))
    .filter((m): m is MemoryHeader => m !== undefined)

  // Fires even on empty selection: selection-rate needs the denominator,
  // and -1 ages distinguish "ran, picked nothing" from "never ran".
  if (feature('MEMORY_SHAPE_TELEMETRY')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { logMemoryRecallShape } =
      require('./memoryShapeTelemetry.js') as typeof import('./memoryShapeTelemetry.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    logMemoryRecallShape(memories, selected)
  }

  return selected.map(m => ({ path: m.filePath, mtimeMs: m.mtimeMs }))
}

async function selectRelevantMemories(
  query: string,
  memories: MemoryHeader[],
  signal: AbortSignal,
  recentTools: readonly string[],
): Promise<string[]> {
  const validFilenames = new Set(memories.map(m => m.filename))

  const manifest = formatMemoryManifest(memories)

  // When Claude Code is actively using a tool (e.g. mcp__X__spawn),
  // surfacing that tool's reference docs is noise — the conversation
  // already contains working usage.  The selector otherwise matches
  // on keyword overlap ("spawn" in query + "spawn" in a memory
  // description → false positive).
  const toolsSection =
    recentTools.length > 0
      ? `\n\nRecently used tools: ${recentTools.join(', ')}`
      : ''

  try {
    const result = await sideQuery({
      model: getDefaultSonnetModel(),
      system: SELECT_MEMORIES_SYSTEM_PROMPT,
      skipSystemPromptPrefix: true,
      messages: [
        {
          role: 'user',
          content: `Query: ${query}\n\nAvailable memories:\n${manifest}${toolsSection}`,
        },
      ],
      max_tokens: 256,
      output_format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            selected_memories: { type: 'array', items: { type: 'string' } },
          },
          required: ['selected_memories'],
          additionalProperties: false,
        },
      },
      signal,
      querySource: 'memdir_relevance',
    })

    const textBlock = result.content.find(block => block.type === 'text')
    if (!textBlock || textBlock.type !== 'text') {
      return []
    }

    const parsedSelection = parseSelectedMemoriesResponse(
      textBlock.text,
      validFilenames,
    )
    return parsedSelection ?? []
  } catch (e) {
    if (signal.aborted) {
      return []
    }
    logForDebugging(
      `[memdir] selectRelevantMemories failed: ${errorMessage(e)}`,
      { level: 'warn' },
    )
    return []
  }
}

function parseSelectedMemoriesResponse(
  text: string,
  validFilenames: ReadonlySet<string>,
): string[] | null {
  try {
    const parsed = getSelectedMemoriesPayload(text)
    if (parsed !== null) {
      return filterSelectedMemories(parsed, validFilenames)
    }
  } catch {
    // Fall through to malformed-JSON recovery below.
  }

  const recovered = recoverSelectedMemoriesPayload(text)
  if (recovered !== null) {
    logForDebugging(
      `[memdir] recovered selected_memories from malformed JSON response`,
    )
    return filterSelectedMemories(recovered, validFilenames)
  }

  return null
}

function filterSelectedMemories(
  selectedMemories: readonly unknown[],
  validFilenames: ReadonlySet<string>,
): string[] {
  return selectedMemories.filter(
    (filename): filename is string =>
      typeof filename === 'string' && validFilenames.has(filename),
  )
}

function getSelectedMemoriesPayload(text: string): unknown[] | null {
  const parsed = jsonParse(text) as { selected_memories?: unknown }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    !Array.isArray(parsed.selected_memories)
  ) {
    return null
  }
  return parsed.selected_memories
}

function recoverSelectedMemoriesPayload(text: string): unknown[] | null {
  const embeddedObject = extractBalancedJsonObject(text)
  if (embeddedObject !== null) {
    try {
      const recovered = getSelectedMemoriesPayload(embeddedObject)
      if (recovered !== null) {
        return recovered
      }
    } catch {
      // Fall through to narrower field-level recovery.
    }
  }

  const selectedMemoriesMatch = text.match(
    /["']?selected_memories["']?\s*:\s*(\[[\s\S]*?\])/,
  )
  if (!selectedMemoriesMatch?.[1]) {
    return null
  }

  const arrayLiteral = selectedMemoriesMatch[1]
  try {
    const parsedArray = jsonParse(arrayLiteral)
    return Array.isArray(parsedArray) ? parsedArray : null
  } catch {
    return parseLooseStringArrayLiteral(arrayLiteral)
  }
}

function extractBalancedJsonObject(text: string): string | null {
  let depth = 0
  let start = -1
  let inString = false
  let quoteChar = ''
  let escaped = false

  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (inString) {
      if (char === '\\') {
        escaped = true
      } else if (char === quoteChar) {
        inString = false
      }
      continue
    }
    if (char === '"' || char === "'") {
      inString = true
      quoteChar = char
      continue
    }
    if (char === '{') {
      if (depth === 0) {
        start = i
      }
      depth++
      continue
    }
    if (char === '}') {
      if (depth === 0) {
        continue
      }
      depth--
      if (depth === 0 && start !== -1) {
        return text.slice(start, i + 1)
      }
    }
  }

  return null
}

function parseLooseStringArrayLiteral(arrayLiteral: string): string[] | null {
  const trimmed = arrayLiteral.trim()
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    return null
  }

  const inner = trimmed.slice(1, -1).trim()
  if (inner.length === 0) {
    return []
  }

  const stringLiteralPattern = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g
  const matches = Array.from(inner.matchAll(stringLiteralPattern))
  if (matches.length === 0) {
    return null
  }

  const residue = inner.replace(stringLiteralPattern, '').replace(/[\s,]/g, '')
  if (residue.length > 0) {
    return null
  }

  const parsed = matches
    .map(match => parseLooseQuotedString(match[0]))
    .filter((value): value is string => value !== null)

  return parsed.length === matches.length ? parsed : null
}

function parseLooseQuotedString(value: string): string | null {
  if (value.startsWith('"')) {
    try {
      const parsed = jsonParse(value)
      return typeof parsed === 'string' ? parsed : null
    } catch {
      return null
    }
  }

  if (!value.startsWith("'") || !value.endsWith("'")) {
    return null
  }

  let result = ''
  const body = value.slice(1, -1)
  for (let i = 0; i < body.length; i++) {
    const char = body[i]
    if (char !== '\\') {
      result += char
      continue
    }

    i++
    if (i >= body.length) {
      return null
    }

    const escaped = body[i]
    switch (escaped) {
      case "'":
      case '"':
      case '\\':
      case '/':
        result += escaped
        break
      case 'b':
        result += '\b'
        break
      case 'f':
        result += '\f'
        break
      case 'n':
        result += '\n'
        break
      case 'r':
        result += '\r'
        break
      case 't':
        result += '\t'
        break
      case 'u': {
        const hex = body.slice(i + 1, i + 5)
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          return null
        }
        result += String.fromCharCode(Number.parseInt(hex, 16))
        i += 4
        break
      }
      default:
        return null
    }
  }

  return result
}
