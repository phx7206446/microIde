import { createHash } from 'crypto'
import { readdir, readFile, stat } from 'fs/promises'
import memoize from 'lodash-es/memoize.js'
import { basename, join, relative } from 'path'
import type { Command } from '../../types/command.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { logError } from '../../utils/log.js'
import {
  isSettingSourceEnabled,
  type SettingSource,
} from '../../utils/settings/constants.js'
import { WORKFLOW_TOOL_NAME } from './constants.js'

export type WorkflowPhaseMeta = {
  title: string
  detail?: string
  // Optional per-phase model override: agents that run in this phase default to
  // this model (unless the agent() call passes opts.model). Mirrors official.
  model?: string
}

export type WorkflowMeta = {
  name: string
  description: string
  whenToUse?: string
  phases: WorkflowPhaseMeta[]
}

export type WorkflowScript = {
  name: string
  description: string
  whenToUse?: string
  phases: WorkflowPhaseMeta[]
  script: string
  scriptPath?: string
  source: SettingSource | 'builtin'
}

type WorkflowLocation = {
  dir: string
  source: SettingSource
}

const JS_WORKFLOW_EXTENSIONS = new Set(['.js'])
const bundledWorkflowScripts = new Map<string, WorkflowScript>()
let bundledWorkflowsInitialized = false

function skipLeadingTrivia(source: string): number {
  let index = source.charCodeAt(0) === 0xfeff ? 1 : 0

  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]

    if (/\s/.test(char ?? '')) {
      index++
      continue
    }

    if (char === '/' && next === '/') {
      index += 2
      while (index < source.length && source[index] !== '\n') index++
      continue
    }

    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2)
      if (end === -1) {
        return index
      }
      index = end + 2
      continue
    }

    break
  }

  return index
}

function findMatchingBrace(source: string, start: number): number {
  let depth = 0
  let quote: '"' | "'" | '`' | null = null
  let escaped = false
  let inLineComment = false
  let inBlockComment = false

  for (let index = start; index < source.length; index++) {
    const char = source[index]!
    const next = source[index + 1]

    if (inLineComment) {
      if (char === '\n') inLineComment = false
      continue
    }

    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false
        index++
      }
      continue
    }

    if (quote) {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === quote) {
        quote = null
      }
      continue
    }

    if (char === '/' && next === '/') {
      inLineComment = true
      index++
      continue
    }

    if (char === '/' && next === '*') {
      inBlockComment = true
      index++
      continue
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }

    if (char === '{') {
      depth++
    } else if (char === '}') {
      depth--
      if (depth === 0) {
        return index
      }
    }
  }

  return -1
}

function normalizePhase(phase: unknown, index: number): WorkflowPhaseMeta {
  if (typeof phase === 'string' && phase.trim()) {
    return { title: phase.trim() }
  }

  if (typeof phase === 'object' && phase !== null) {
    const record = phase as Record<string, unknown>
    const title = record.title
    const detail = record.detail
    const model = record.model
    if (typeof title === 'string' && title.trim()) {
      return {
        title: title.trim(),
        ...(typeof detail === 'string' && detail.trim()
          ? { detail: detail.trim() }
          : {}),
        ...(typeof model === 'string' && model.trim()
          ? { model: model.trim() }
          : {}),
      }
    }
  }

  throw new Error(`Workflow phase ${index + 1} must have a title`)
}

function validateWorkflowMeta(value: unknown): WorkflowMeta {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Workflow meta must be an object literal')
  }

  const meta = value as Record<string, unknown>
  if (typeof meta.name !== 'string' || !meta.name.trim()) {
    throw new Error('Workflow meta.name must be a non-empty string')
  }
  if (
    typeof meta.description !== 'string' ||
    !meta.description.trim()
  ) {
    throw new Error('Workflow meta.description must be a non-empty string')
  }
  // phases is OPTIONAL (matches official). Only reject a present-but-non-array
  // value; a {name, description}-only meta is valid.
  if (meta.phases !== undefined && !Array.isArray(meta.phases)) {
    throw new Error('Workflow meta.phases must be an array')
  }

  return {
    name: meta.name.trim(),
    description: meta.description.trim(),
    ...(typeof meta.whenToUse === 'string' && meta.whenToUse.trim()
      ? { whenToUse: meta.whenToUse.trim() }
      : {}),
    phases: Array.isArray(meta.phases) ? meta.phases.map(normalizePhase) : [],
  }
}

class PureLiteralParser {
  private index = 0

  constructor(private readonly source: string) {}

  parse(): unknown {
    const value = this.parseValue()
    this.skipTrivia()
    if (this.index !== this.source.length) {
      throw new Error('Workflow meta must be a pure object literal')
    }
    return value
  }

  private parseValue(): unknown {
    this.skipTrivia()
    const char = this.peek()
    if (char === '{') return this.parseObject()
    if (char === '[') return this.parseArray()
    if (char === '"' || char === "'") {
      return this.parseString()
    }
    if (char === '-' || this.isDigit(char)) return this.parseNumber()
    const ident = this.parseIdentifier()
    switch (ident) {
      case 'true':
        return true
      case 'false':
        return false
      case 'null':
        return null
      default:
        throw new Error('Workflow meta must contain only literal values')
    }
  }

  private parseObject(): Record<string, unknown> {
    const value: Record<string, unknown> = {}
    this.expect('{')
    this.skipTrivia()
    if (this.consume('}')) return value

    while (true) {
      this.skipTrivia()
      if (this.source.startsWith('...', this.index) || this.peek() === '[') {
        throw new Error('Workflow meta cannot use spread or computed keys')
      }

      const key = this.parsePropertyKey()
      this.skipTrivia()
      this.expect(':')
      value[key] = this.parseValue()
      this.skipTrivia()

      if (this.consume('}')) return value
      this.expect(',')
      this.skipTrivia()
      if (this.consume('}')) return value
    }
  }

  private parseArray(): unknown[] {
    const value: unknown[] = []
    this.expect('[')
    this.skipTrivia()
    if (this.consume(']')) return value

    while (true) {
      if (this.source.startsWith('...', this.index)) {
        throw new Error('Workflow meta cannot use spread values')
      }
      value.push(this.parseValue())
      this.skipTrivia()

      if (this.consume(']')) return value
      this.expect(',')
      this.skipTrivia()
      if (this.consume(']')) return value
    }
  }

  private parsePropertyKey(): string {
    const char = this.peek()
    if (char === '"' || char === "'") {
      return this.parseString()
    }
    return this.parseIdentifier()
  }

  private parseString(): string {
    const quote = this.peek()
    if (quote !== '"' && quote !== "'") {
      throw new Error('Workflow meta expected a string literal')
    }
    this.index++
    let value = ''

    while (this.index < this.source.length) {
      const char = this.source[this.index++]!
      if (char === quote) return value
      if (char !== '\\') {
        value += char
        continue
      }

      const escaped = this.source[this.index++]
      switch (escaped) {
        case 'n':
          value += '\n'
          break
        case 'r':
          value += '\r'
          break
        case 't':
          value += '\t'
          break
        case 'b':
          value += '\b'
          break
        case 'f':
          value += '\f'
          break
        case 'v':
          value += '\v'
          break
        case '0':
          value += '\0'
          break
        case 'u':
          value += this.parseHexEscape(4)
          break
        case 'x':
          value += this.parseHexEscape(2)
          break
        case '\\':
        case '"':
        case "'":
          value += escaped
          break
        default:
          if (escaped === undefined) {
            throw new Error('Workflow meta string escape is incomplete')
          }
          value += escaped
      }
    }

    throw new Error('Workflow meta string literal is not closed')
  }

  private parseHexEscape(length: number): string {
    const raw = this.source.slice(this.index, this.index + length)
    if (!new RegExp(`^[0-9A-Fa-f]{${length}}$`).test(raw)) {
      throw new Error('Workflow meta string escape is invalid')
    }
    this.index += length
    return String.fromCharCode(Number.parseInt(raw, 16))
  }

  private parseNumber(): number {
    const start = this.index
    if (this.peek() === '-') this.index++
    while (this.isDigit(this.peek())) this.index++
    if (this.peek() === '.') {
      this.index++
      while (this.isDigit(this.peek())) this.index++
    }
    if (this.peek() === 'e' || this.peek() === 'E') {
      this.index++
      if (this.peek() === '+' || this.peek() === '-') this.index++
      while (this.isDigit(this.peek())) this.index++
    }

    const raw = this.source.slice(start, this.index)
    const value = Number(raw)
    if (!Number.isFinite(value)) {
      throw new Error('Workflow meta number literal is invalid')
    }
    return value
  }

  private parseIdentifier(): string {
    const first = this.peek()
    if (!/[A-Za-z_$]/.test(first ?? '')) {
      throw new Error('Workflow meta expected a literal value')
    }
    const start = this.index
    this.index++
    while (/[\w$]/.test(this.peek() ?? '')) this.index++
    return this.source.slice(start, this.index)
  }

  private skipTrivia(): void {
    while (this.index < this.source.length) {
      const char = this.peek()
      const next = this.source[this.index + 1]
      if (/\s/.test(char ?? '')) {
        this.index++
        continue
      }
      if (char === '/' && next === '/') {
        this.index += 2
        while (this.index < this.source.length && this.peek() !== '\n') {
          this.index++
        }
        continue
      }
      if (char === '/' && next === '*') {
        const end = this.source.indexOf('*/', this.index + 2)
        if (end === -1) {
          throw new Error('Workflow meta block comment is not closed')
        }
        this.index = end + 2
        continue
      }
      break
    }
  }

  private expect(char: string): void {
    if (!this.consume(char)) {
      throw new Error(`Workflow meta expected \`${char}\``)
    }
  }

  private consume(char: string): boolean {
    if (this.peek() !== char) return false
    this.index++
    return true
  }

  private peek(): string | undefined {
    return this.source[this.index]
  }

  private isDigit(char: string | undefined): boolean {
    return /[0-9]/.test(char ?? '')
  }
}

function parseLiteralMeta(literal: string): WorkflowMeta {
  return validateWorkflowMeta(new PureLiteralParser(literal).parse())
}

export function parseWorkflowScript(source: string): {
  meta: WorkflowMeta
  body: string
} {
  const start = skipLeadingTrivia(source)
  const header = 'export const meta'

  if (!source.startsWith(header, start)) {
    throw new Error(
      'Workflow script must begin with `export const meta = { name, description, phases }`',
    )
  }

  const equalsIndex = source.indexOf('=', start + header.length)
  if (equalsIndex === -1) {
    throw new Error('Workflow meta declaration is missing `=`')
  }

  const objectStart = source.indexOf('{', equalsIndex + 1)
  if (objectStart === -1) {
    throw new Error('Workflow meta declaration must use an object literal')
  }

  const objectEnd = findMatchingBrace(source, objectStart)
  if (objectEnd === -1) {
    throw new Error('Workflow meta object is not closed')
  }

  let bodyStart = objectEnd + 1
  while (source[bodyStart] === ';' || /\s/.test(source[bodyStart] ?? '')) {
    bodyStart++
  }

  const body = source.slice(bodyStart)
  if (/^\s*(?:export|import)\s/m.test(body)) {
    throw new Error('Workflow scripts cannot import or export additional modules')
  }

  return {
    meta: parseLiteralMeta(source.slice(objectStart, objectEnd + 1)),
    body,
  }
}

export function hashWorkflowCall(input: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(input))
    .digest('hex')
    .slice(0, 24)
}

function getWorkflowLocations(cwd: string): WorkflowLocation[] {
  const locations: WorkflowLocation[] = []

  if (isSettingSourceEnabled('userSettings')) {
    locations.push({
      dir: join(getClaudeConfigHomeDir(), 'workflows'),
      source: 'userSettings',
    })
  }

  if (isSettingSourceEnabled('projectSettings')) {
    locations.push({
      dir: join(cwd, '.claude', 'workflows'),
      source: 'projectSettings',
    })
  }

  return locations
}

export function registerBundledWorkflow(script: string): void {
  const { meta } = parseWorkflowScript(script)
  bundledWorkflowScripts.set(meta.name, {
    ...meta,
    script,
    source: 'builtin',
  })
}

async function ensureBundledWorkflowsInitialized(): Promise<void> {
  if (bundledWorkflowsInitialized) return
  bundledWorkflowsInitialized = true
  const { initBundledWorkflows } = await import('./bundled/index.js')
  initBundledWorkflows()
}

async function collectTopLevelWorkflowFiles(dir: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const files: string[] = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (!entry.isFile()) {
      continue
    }
    const ext = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase()
    if (JS_WORKFLOW_EXTENSIONS.has(ext)) {
      files.push(path)
    }
  }
  return files
}

function createWorkflowPromptCommand(workflow: WorkflowScript): Command {
  const description = workflow.description
  return {
    type: 'prompt',
    kind: 'workflow',
    name: workflow.name,
    description,
    whenToUse: workflow.whenToUse,
    progressMessage: 'loading workflow',
    contentLength: workflow.script.length,
    source: workflow.source,
    loadedFrom: workflow.source === 'builtin' ? 'bundled' : 'skills',
    userInvocable: true,
    hasUserSpecifiedDescription: true,
    async getPromptForCommand(args) {
      const trimmedArgs = args.trim()
      return [
        {
          type: 'text',
          text: [
            `Run the predefined dynamic workflow "${workflow.name}" using the ${WORKFLOW_TOOL_NAME} tool.`,
            `Description: ${description}`,
            workflow.whenToUse ? `When to use: ${workflow.whenToUse}` : null,
            trimmedArgs
              ? `User-provided workflow arguments: ${trimmedArgs}`
              : 'No workflow arguments were provided.',
            '',
            `Call ${WORKFLOW_TOOL_NAME} with { "name": "${workflow.name}" }. If arguments were provided as natural language, pass them exactly as a string in "args"; if the user explicitly provided a JSON object, pass that object in "args". Do not manually expand this workflow as a normal skill.`,
          ]
            .filter(line => line !== null)
            .join('\n'),
        },
      ]
    },
  }
}

export const getWorkflowScripts = memoize(
  async (cwd: string): Promise<WorkflowScript[]> => {
    await ensureBundledWorkflowsInitialized()
    const workflows = new Map<string, WorkflowScript>(bundledWorkflowScripts)

    for (const location of getWorkflowLocations(cwd)) {
      const files = await collectTopLevelWorkflowFiles(location.dir)
      for (const filePath of files) {
        try {
          const stats = await stat(filePath)
          if (!stats.isFile()) continue

          const script = await readFile(filePath, 'utf8')
          const { meta } = parseWorkflowScript(script)
          workflows.set(meta.name, {
            ...meta,
            script,
            scriptPath: filePath,
            source: location.source,
          })
        } catch (error) {
          logError(
            new Error(
              `Failed to load workflow ${relative(process.cwd(), filePath)}: ${String(error)}`,
            ),
          )
        }
      }
    }

    return [...workflows.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    )
  },
)

export async function getWorkflowCommands(cwd: string): Promise<Command[]> {
  return (await getWorkflowScripts(cwd)).map(createWorkflowPromptCommand)
}

export async function resolveWorkflowByName(
  cwd: string,
  name: string,
): Promise<WorkflowScript | null> {
  const normalized = name.trim().replace(/^\//, '')
  const workflows = await getWorkflowScripts(cwd)
  return (
    workflows.find(workflow => workflow.name === normalized) ??
    workflows.find(
      workflow =>
        workflow.scriptPath &&
        basename(workflow.scriptPath, '.js') === normalized,
    ) ??
    null
  )
}
