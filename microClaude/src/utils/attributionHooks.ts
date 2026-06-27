import { registerHookCallbacks } from '../bootstrap/state.js'
import type { HookInput, HookJSONOutput } from '../entrypoints/agentSdkTypes.js'
import { FILE_EDIT_TOOL_NAME } from '../tools/FileEditTool/constants.js'
import {
  outputSchema as fileEditOutputSchema,
  type FileEditOutput,
} from '../tools/FileEditTool/types.js'
import {
  FileWriteTool,
  type Output as FileWriteOutput,
} from '../tools/FileWriteTool/FileWriteTool.js'
import { FILE_WRITE_TOOL_NAME } from '../tools/FileWriteTool/prompt.js'
import type { HookCallback, HookCallbackContext } from '../types/hooks.js'
import {
  getFileMtime,
  trackFileCreation,
  trackFileModification,
} from './commitAttribution.js'

type CachedFileContent = {
  content: string
  touchedAt: number
}

const FILE_CONTENT_CACHE_TTL_MS = 5 * 60 * 1000
const MAX_FILE_CONTENT_CACHE_SIZE = 128

const fileContentCache = new Map<string, CachedFileContent>()

let attributionHooksRegistered = false

function cacheFileContent(filePath: string, content: string): void {
  fileContentCache.set(filePath, {
    content,
    touchedAt: Date.now(),
  })
}

function trimFileContentCache(now: number): void {
  for (const [filePath, entry] of fileContentCache) {
    if (now - entry.touchedAt > FILE_CONTENT_CACHE_TTL_MS) {
      fileContentCache.delete(filePath)
    }
  }

  if (fileContentCache.size <= MAX_FILE_CONTENT_CACHE_SIZE) {
    return
  }

  const oldestEntries = Array.from(fileContentCache.entries()).sort(
    (a, b) => a[1].touchedAt - b[1].touchedAt,
  )
  for (const [filePath] of oldestEntries.slice(
    0,
    fileContentCache.size - MAX_FILE_CONTENT_CACHE_SIZE,
  )) {
    fileContentCache.delete(filePath)
  }
}

function applyStructuredPatchToContent(
  originalFile: string,
  structuredPatch: FileEditOutput['structuredPatch'],
): string {
  if (structuredPatch.length === 0) {
    return originalFile
  }

  const originalLines = originalFile.split('\n')
  const resultLines: string[] = []
  let originalIndex = 0

  for (const hunk of structuredPatch) {
    const hunkStartIndex = Math.max(hunk.oldStart - 1, 0)
    while (originalIndex < hunkStartIndex) {
      resultLines.push(originalLines[originalIndex] ?? '')
      originalIndex++
    }

    for (const line of hunk.lines) {
      if (line === '\\ No newline at end of file') {
        continue
      }

      const prefix = line[0]
      const content = line.slice(1)

      switch (prefix) {
        case ' ':
          resultLines.push(originalLines[originalIndex] ?? content)
          originalIndex++
          break
        case '-':
          originalIndex++
          break
        case '+':
          resultLines.push(content)
          break
      }
    }
  }

  while (originalIndex < originalLines.length) {
    resultLines.push(originalLines[originalIndex] ?? '')
    originalIndex++
  }

  return resultLines.join('\n')
}

function parseFileEditOutput(toolResponse: unknown): FileEditOutput | null {
  const parsed = fileEditOutputSchema().safeParse(toolResponse)
  return parsed.success ? parsed.data : null
}

function parseFileWriteOutput(toolResponse: unknown): FileWriteOutput | null {
  const parsed = FileWriteTool.outputSchema.safeParse(toolResponse)
  return parsed.success ? parsed.data : null
}

async function trackFileEditAttribution(
  toolResponse: unknown,
  context: HookCallbackContext,
): Promise<void> {
  const output = parseFileEditOutput(toolResponse)
  if (!output) {
    return
  }

  const updatedFile = applyStructuredPatchToContent(
    output.originalFile,
    output.structuredPatch,
  )
  const mtime = await getFileMtime(output.filePath)

  context.updateAttributionState(prev =>
    trackFileModification(
      prev,
      output.filePath,
      output.originalFile,
      updatedFile,
      output.userModified,
      mtime,
    ),
  )

  cacheFileContent(output.filePath, updatedFile)
}

async function trackFileWriteAttribution(
  toolResponse: unknown,
  context: HookCallbackContext,
): Promise<void> {
  const output = parseFileWriteOutput(toolResponse)
  if (!output) {
    return
  }

  const mtime = await getFileMtime(output.filePath)

  context.updateAttributionState(prev =>
    output.type === 'create'
      ? trackFileCreation(prev, output.filePath, output.content, mtime)
      : trackFileModification(
          prev,
          output.filePath,
          output.originalFile ?? '',
          output.content,
          false,
          mtime,
        ),
  )

  cacheFileContent(output.filePath, output.content)
}

async function handleAttributionHook(
  input: HookInput,
  _toolUseID: string | null,
  _signal: AbortSignal | undefined,
  _hookIndex: number | undefined,
  context?: HookCallbackContext,
): Promise<HookJSONOutput> {
  if (input.hook_event_name !== 'PostToolUse' || !context) {
    return {}
  }

  switch (input.tool_name) {
    case FILE_EDIT_TOOL_NAME:
      await trackFileEditAttribution(input.tool_response, context)
      break
    case FILE_WRITE_TOOL_NAME:
      await trackFileWriteAttribution(input.tool_response, context)
      break
  }

  return {}
}

export function registerAttributionHooks(): void {
  if (attributionHooksRegistered) {
    return
  }

  attributionHooksRegistered = true

  const hook: HookCallback = {
    type: 'callback',
    callback: handleAttributionHook,
    timeout: 1,
    internal: true,
  }

  registerHookCallbacks({
    PostToolUse: [
      { matcher: FILE_EDIT_TOOL_NAME, hooks: [hook] },
      { matcher: FILE_WRITE_TOOL_NAME, hooks: [hook] },
    ],
  })
}

export function clearAttributionCaches(): void {
  fileContentCache.clear()
}

export function sweepFileContentCache(): void {
  trimFileContentCache(Date.now())
}
