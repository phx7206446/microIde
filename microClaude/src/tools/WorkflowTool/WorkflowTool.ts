import { createHash, randomUUID } from 'crypto'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { cpus } from 'os'
import { sleep } from '../../utils/sleep.js'
import memoize from 'lodash-es/memoize.js'
import { basename, dirname, join, resolve } from 'path'
import React from 'react'
import { Script, createContext } from 'vm'
import { z } from 'zod/v4'
import { getProjectRoot, getSessionId } from '../../bootstrap/state.js'
import { clearInvokedSkillsForAgent } from '../../bootstrap/state.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import type {
  Tool,
  ToolResult,
  Tools,
  ToolUseContext,
  ValidationResult,
} from '../../Tool.js'
import { buildTool, toolMatchesName, type ToolDef } from '../../Tool.js'
import { Box, Text } from '../../ink.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { Message } from '../../types/message.js'
import { AbortError, errorMessage } from '../../utils/errors.js'
import type { ModelAlias } from '../../utils/model/aliases.js'
import { getRuleByContentsForTool } from '../../utils/permissions/permissions.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { emitTaskProgress as emitTaskProgressEvent } from '../../utils/task/sdkProgress.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logForDebugging } from '../../utils/debug.js'
import { getTranscriptPath } from '../../utils/sessionStorage.js'
import { appendTaskOutput, initTaskOutput } from '../../utils/task/diskOutput.js'
import { createAgentId } from '../../utils/uuid.js'
import {
  createAgentWorktree,
  hasWorktreeChanges,
  removeAgentWorktree,
} from '../../utils/worktree.js'
import { clearDumpState } from '../../services/api/dumpPrompts.js'
import { asAgentId } from '../../types/ids.js'
import { getCwd, runWithCwdOverride } from '../../utils/cwd.js'
import {
  clearAgentTranscriptSubdir,
  setAgentTranscriptSubdir,
} from '../../utils/sessionStorage.js'
import { runAgent } from '../AgentTool/runAgent.js'
import {
  countToolUses,
  extractPartialResult,
  getLastToolUseName,
} from '../AgentTool/agentToolUtils.js'
import {
  createActivityDescriptionResolver,
  createProgressTracker,
  getProgressUpdate,
  getTokenCountFromTracker,
  updateProgressFromMessage,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import {
  clearWorkflowAgentController,
  completeWorkflowTask,
  enqueueWorkflowNotification,
  failWorkflowTask,
  killWorkflowTask,
  registerWorkflowTask,
  setWorkflowAgentRestartHandler,
  setWorkflowAgentSkipHandler,
  setWorkflowAgentController,
  setWorkflowRestartHandler,
  updateWorkflowTaskProgress,
} from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import { createChildAbortController } from '../../utils/abortController.js'
import { parseToolListFromCLI } from '../../utils/permissions/permissionSetup.js'
import { createUserMessage } from '../../utils/messages.js'
import { BASH_TOOL_NAME } from '../BashTool/toolName.js'
import {
  CRON_CREATE_TOOL_NAME,
  CRON_DELETE_TOOL_NAME,
  CRON_LIST_TOOL_NAME,
} from '../ScheduleCronTool/prompt.js'
import { FILE_EDIT_TOOL_NAME } from '../FileEditTool/constants.js'
import { ENTER_WORKTREE_TOOL_NAME } from '../EnterWorktreeTool/constants.js'
import { EXIT_WORKTREE_TOOL_NAME } from '../ExitWorktreeTool/constants.js'
import { GLOB_TOOL_NAME } from '../GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '../GrepTool/prompt.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../NotebookEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'
import { SKILL_TOOL_NAME } from '../SkillTool/constants.js'
import { TASK_STOP_TOOL_NAME } from '../TaskStopTool/prompt.js'
import { TODO_WRITE_TOOL_NAME } from '../TodoWriteTool/constants.js'
import { WEB_FETCH_TOOL_NAME } from '../WebFetchTool/prompt.js'
import { WEB_SEARCH_TOOL_NAME } from '../WebSearchTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../FileWriteTool/prompt.js'
import {
  createSyntheticOutputTool,
  SYNTHETIC_OUTPUT_TOOL_NAME,
} from '../SyntheticOutputTool/SyntheticOutputTool.js'
import { registerStructuredOutputEnforcement } from '../../utils/hooks/hookHelpers.js'
import { clearSessionHooks } from '../../utils/hooks/sessionHooks.js'
import type { SdkWorkflowProgress } from '../../types/tools.js'
import type { AgentDefinition } from '../AgentTool/loadAgentsDir.js'
import {
  getWorkflowSubagentAgent,
  withWorkflowNote,
} from '../AgentTool/built-in/workflowSubagent.js'
import { WORKFLOW_TOOL_NAME } from './constants.js'
import {
  hashWorkflowCall,
  parseWorkflowScript,
  resolveWorkflowByName,
  getWorkflowScripts,
  type WorkflowMeta,
  type WorkflowPhaseMeta,
} from './workflowScripts.js'

type WorkflowArgs = string | Record<string, unknown>

type CachedWorkflowAgentResult = {
  value: unknown
  content: string
  totalDurationMs: number
  totalTokens: number
  totalToolUseCount: number
}

type WorkflowRunCache = {
  runId: string
  scriptPath?: string
  calls: Map<string, CachedWorkflowAgentResult>
}

type WorkflowAgentOptions = {
  label?: string
  phase?: string
  agent?: string
  agentType?: string
  model?: string
  maxTurns?: number
  allowedTools?: string[]
  tools?: string[]
  schema?: Record<string, unknown>
  isolation?: 'worktree'
}

const workflowRunCaches = new Map<string, WorkflowRunCache>()
const MAX_WORKFLOW_CONCURRENT_AGENTS = positiveIntegerEnv(
  'CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS',
  Math.max(1, Math.min(16, cpus().length - 2)),
)
const MAX_WORKFLOW_TOTAL_AGENTS = 1000
const DEFAULT_WORKFLOW_AGENT_STALL_MS = 180_000
// Official retries a stalled workflow agent up to 5 times.
const MAX_WORKFLOW_AGENT_ATTEMPTS = 5
// Throttle backoff: when an agent returns a degraded/throttled response
// (no stop_reason, < this many output tokens, in > half the stall window),
// sleep this long and retry the agent once. Mirrors official behavior.
const WORKFLOW_THROTTLE_BACKOFF_MS = 45_000
const WORKFLOW_DEGRADED_OUTPUT_TOKENS = 50
// Cap workflow_log narrator entries kept in the progress payload.
const WORKFLOW_LOG_MAX_ENTRIES = 50
const WORKFLOW_AGENT_VISIBLE_TOOL_NAMES = [
  BASH_TOOL_NAME,
  CRON_CREATE_TOOL_NAME,
  CRON_DELETE_TOOL_NAME,
  CRON_LIST_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  ENTER_WORKTREE_TOOL_NAME,
  EXIT_WORKTREE_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
  FILE_READ_TOOL_NAME,
  SKILL_TOOL_NAME,
  TASK_STOP_TOOL_NAME,
  TODO_WRITE_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
] as const

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

const WORKFLOW_AGENT_STALL_MS = positiveIntegerEnv(
  'CLAUDE_CODE_WORKFLOW_AGENT_STALL_MS',
  DEFAULT_WORKFLOW_AGENT_STALL_MS,
)

const inputSchema = lazySchema(() =>
  z.strictObject({
    script: z
      .string()
      .optional()
      .describe(
        'Self-contained workflow script beginning with `export const meta = { name, description, phases }` and using agent()/parallel()/pipeline()/phase().',
      ),
    name: z
      .string()
      .optional()
      .describe('Name of a predefined workflow from .claude/workflows/.'),
    description: z
      .string()
      .optional()
      .describe('Ignored. Set the workflow description in the script meta block.'),
    title: z
      .string()
      .optional()
      .describe('Ignored. Set the workflow title in the script meta block.'),
    args: z
      .union([z.string(), z.record(z.string(), z.unknown())])
      .optional()
      .describe(
        'String or JSON object exposed to the workflow script as global `args`.',
      ),
    scriptPath: z
      .string()
      .optional()
      .describe(
        'Path to a persisted workflow script file. Takes precedence over script and name.',
      ),
    resumeFromRunId: z
      .string()
      .optional()
      .describe(
        'Run ID of a prior same-session Workflow invocation to reuse unchanged completed agent() results.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    status: z.enum(['async_launched', 'remote_launched']),
    taskId: z.string(),
    runId: z.string().optional(),
    summary: z.string().optional(),
    transcriptDir: z.string().optional(),
    scriptPath: z.string().optional(),
    sessionUrl: z.string().optional(),
    warning: z.string().optional(),
    error: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
type Output = z.input<OutputSchema>

function normalizeWorkflowName(name: string): string {
  const trimmed = name.trim()
  return trimmed.startsWith('/') ? trimmed.slice(1) : trimmed
}

function workflowIdentity(input: z.input<InputSchema>): string {
  if (input.scriptPath?.trim()) {
    return `scriptPath:${resolve(getCwd(), input.scriptPath)}`
  }
  if (input.name?.trim()) return normalizeWorkflowName(input.name)
  if (input.script?.trim()) {
    return `script:${createHash('sha256').update(input.script).digest('hex').slice(0, 12)}`
  }
  return ''
}

function workflowDisplayName(input: Partial<z.input<InputSchema>>): string {
  if (input.name?.trim()) {
    return normalizeWorkflowName(input.name)
  }
  if (input.scriptPath?.trim()) {
    return basename(input.scriptPath, '.js')
  }
  if (input.script?.trim()) {
    try {
      return parseWorkflowScript(input.script).meta.name
    } catch {
      return 'generated workflow'
    }
  }
  return 'dynamic workflow'
}

function formatWorkflowValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function previewWorkflowText(value: string, maxLength = 500): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > maxLength
    ? `${text.slice(0, Math.max(0, maxLength - 3))}...`
    : text
}

function safeWorkflowFileName(value: string): string {
  return (
    value
      .trim()
      .replace(/^\//, '')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'workflow'
  )
}

function createWorkflowRunId(): string {
  const id = randomUUID()
  return `wf_${id.slice(0, 8)}-${id.slice(9, 12)}`
}

function getAgentFailureMessage(messages: readonly Message[]): string | undefined {
  const failed = messages.find(
    message =>
      message.type === 'assistant' &&
      (message.apiError || message.error || message.isApiErrorMessage),
  )
  if (!failed || failed.type !== 'assistant') return undefined
  if (failed.errorDetails) return failed.errorDetails
  if (typeof failed.apiError === 'string') return failed.apiError
  if (failed.error) return errorMessage(failed.error)
  return extractPartialResult([failed]) ?? 'Agent failed'
}

function phaseTitle(phase: WorkflowPhaseMeta, index: number): string {
  return phase.title || `Phase ${index + 1}`
}

function buildInitialProgress(meta: WorkflowMeta): SdkWorkflowProgress[] {
  return meta.phases.map((phase, index) => ({
    type: 'workflow_phase',
    index: index + 1,
    title: phaseTitle(phase, index),
    detail: phase.detail,
  }))
}

function coerceWorkflowOptions(options: unknown): WorkflowAgentOptions {
  if (typeof options !== 'object' || options === null) {
    return {}
  }

  const record = options as Record<string, unknown>
  const stringArray = (value: unknown): string[] | undefined =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : undefined

  return {
    ...(typeof record.label === 'string' ? { label: record.label } : {}),
    ...(typeof record.phase === 'string' ? { phase: record.phase } : {}),
    ...(typeof record.agent === 'string' ? { agent: record.agent } : {}),
    ...(typeof record.agentType === 'string'
      ? { agentType: record.agentType }
      : {}),
    ...(typeof record.model === 'string' ? { model: record.model } : {}),
    ...(typeof record.maxTurns === 'number' && Number.isFinite(record.maxTurns)
      ? { maxTurns: Math.max(1, Math.floor(record.maxTurns)) }
      : {}),
    ...(stringArray(record.allowedTools)
      ? { allowedTools: stringArray(record.allowedTools) }
      : {}),
    ...(stringArray(record.tools) ? { tools: stringArray(record.tools) } : {}),
    ...(typeof record.schema === 'object' && record.schema !== null
      ? { schema: record.schema as Record<string, unknown> }
      : {}),
    ...(record.isolation === 'worktree' ? { isolation: 'worktree' } : {}),
  }
}

function getAllowedTools(options: WorkflowAgentOptions): string[] | undefined {
  const declared = options.allowedTools ?? options.tools ?? []
  const allowed = parseToolListFromCLI(declared)
  return allowed.length > 0 ? [...new Set(allowed)] : undefined
}

function resolveWorkflowAgent(
  agents: readonly AgentDefinition[],
  options: WorkflowAgentOptions,
): AgentDefinition {
  const hasSchema = Boolean(options.schema)
  const requested = options.agentType ?? options.agent
  if (requested) {
    const custom = agents.find(agent => agent.agentType === requested)
    if (custom) {
      // Keep the custom agentType's own prompt; append the workflow
      // return-contract note (mirrors the official _V5/KV5 suffixes).
      return withWorkflowNote(custom, hasSchema)
    }
  }
  // Default: the dedicated internal workflow-subagent with the official
  // $V5 (no schema) / fV5 (schema) system prompt. Tool visibility is still
  // enforced by resolveWorkflowAgentTools (the provided 18-tool set).
  return getWorkflowSubagentAgent(hasSchema)
}

function resolveWorkflowAgentTools(
  tools: Tools,
  structuredOutputTool?: Tool,
): Tools {
  const resolved: Tool[] = []
  const usedToolNames = new Set<string>()

  for (const toolName of WORKFLOW_AGENT_VISIBLE_TOOL_NAMES) {
    const tool = tools.find(candidate => toolMatchesName(candidate, toolName))
    if (tool && !usedToolNames.has(tool.name)) {
      resolved.push(tool)
      usedToolNames.add(tool.name)
    }
  }

  if (structuredOutputTool) {
    resolved.push(structuredOutputTool)
  }

  return resolved
}

function runWorkflowAgentRequest({
  agentDefinition,
  prompt,
  context,
  canUseTool,
  workflowName,
  options,
  model,
  structuredOutputTool,
  agentId,
  abortController,
  worktreePath,
  description,
  transcriptSubdir,
}: {
  agentDefinition: AgentDefinition
  prompt: string
  context: ToolUseContext
  canUseTool: CanUseToolFn
  workflowName: string
  options: WorkflowAgentOptions
  /** Effective model = opts.model ?? phase.model; undefined inherits default. */
  model?: string
  structuredOutputTool?: Tool
  agentId: string
  abortController: AbortController
  worktreePath?: string
  description: string
  transcriptSubdir: string
}): ReturnType<typeof runAgent> {
  return runAgent({
    agentDefinition,
    promptMessages: [createUserMessage({ content: prompt })],
    toolUseContext: context,
    canUseTool,
    isAsync: true,
    querySource: `workflow:${workflowName}`,
    model: (model ?? options.model) as ModelAlias | undefined,
    maxTurns: options.maxTurns,
    availableTools: resolveWorkflowAgentTools(
      context.options.tools,
      structuredOutputTool,
    ),
    toolResolution: 'provided',
    allowedTools: getAllowedTools(options),
    override: {
      agentId: asAgentId(agentId),
      abortController,
    },
    worktreePath,
    description,
    transcriptSubdir,
  })
}

async function persistWorkflowScript(
  workflowName: string,
  runId: string,
  script: string,
): Promise<string> {
  const transcriptPath = getTranscriptPath()
  const sessionDir = join(dirname(transcriptPath), getSessionId())
  const workflowDir = join(sessionDir, 'workflows', 'scripts')
  await mkdir(workflowDir, { recursive: true })
  const scriptPath = join(workflowDir, `${safeWorkflowFileName(workflowName)}-${runId}.js`)
  await writeFile(scriptPath, script, 'utf8')
  return scriptPath
}

async function loadWorkflowScript(input: z.input<InputSchema>): Promise<{
  script: string
  scriptPath?: string
}> {
  if (input.scriptPath?.trim()) {
    const scriptPath = resolve(getCwd(), input.scriptPath)
    return {
      script: await readFile(scriptPath, 'utf8'),
      scriptPath,
    }
  }

  if (input.name?.trim()) {
    const workflow = await resolveWorkflowByName(
      getProjectRoot(),
      normalizeWorkflowName(input.name),
    )
    if (!workflow) {
      throw new Error(`Unknown workflow: ${normalizeWorkflowName(input.name)}`)
    }
    return {
      script: workflow.script,
      scriptPath: workflow.scriptPath,
    }
  }

  if (input.script?.trim()) {
    return { script: input.script }
  }

  throw new Error('Workflow requires scriptPath, script, or name')
}

async function cleanupWorktreeIfNeeded(
  worktreeInfo: Awaited<ReturnType<typeof createAgentWorktree>> | null,
): Promise<{ worktreePath?: string; worktreeBranch?: string }> {
  if (!worktreeInfo) {
    return {}
  }

  const { worktreePath, worktreeBranch, headCommit, gitRoot, hookBased } =
    worktreeInfo

  if (hookBased) {
    logForDebugging(`Hook-based workflow worktree kept at: ${worktreePath}`)
    return { worktreePath }
  }

  if (headCommit) {
    const changed = await hasWorktreeChanges(worktreePath, headCommit)
    if (!changed) {
      await removeAgentWorktree(worktreePath, worktreeBranch, gitRoot, hookBased)
      return {}
    }
  }

  logForDebugging(`Workflow worktree has changes, keeping: ${worktreePath}`)
  return { worktreePath, worktreeBranch }
}

const getWorkflowPrompt = memoize(async (cwd: string): Promise<string> => {
  const workflows = await getWorkflowScripts(cwd)
  const listing =
    workflows.length === 0
      ? '- No predefined workflows are currently available.'
      : workflows
          .map(
            workflow =>
              `- ${workflow.name}: ${workflow.description} (${workflow.scriptPath ?? workflow.source})`,
          )
          .join('\n')

  return `Execute a workflow script that orchestrates multiple subagents deterministically. Workflows run in the background — this tool returns immediately with a task ID, and a <task-notification> arrives when the workflow completes. Use /workflows to watch live progress.

A workflow encodes structure across many agents: fan out to be comprehensive, run independent perspectives to be confident, or take on scale one context can't hold (migrations, audits, broad sweeps). The script is where you express what fans out, what verifies, and what synthesizes.

ONLY call this tool when the user has explicitly opted into multi-agent orchestration — it can spawn dozens of agents and spend many tokens, so the user must request that scale, not have it inferred. Explicit opt-in means one of:
- The user used the word "workflow" / "workflows".
- The user asked you to run a workflow, fan out agents, or orchestrate subagents in their own words.
- The user invoked a skill or slash command whose instructions tell you to call Workflow.
- The user asked for a specific named/saved workflow.
For any other task — even one that would clearly benefit from parallelism — do NOT call this tool. Use the Agent tool for a single subagent, or describe what a workflow could do and ask first.

The right move is often hybrid: scout inline first (list files, scope the work) to discover the work-list, then call Workflow to pipeline over it.

## Script shape

Every script must begin with a PURE LITERAL meta (no variables, function calls, spreads, or template interpolation):
\`\`\`
export const meta = {
  name: 'find-flaky-tests',
  description: 'Find flaky tests and propose fixes',   // one-line, shown in the permission dialog
  phases: [                                            // optional; one entry per phase() call
    { title: 'Scan', detail: 'grep test logs for retries' },
    { title: 'Fix', detail: 'one agent per flaky test' },
  ],
}
// script body — async context, use await directly
phase('Scan')
const flaky = await agent('grep CI logs for retry markers', { schema: FLAKY_SCHEMA })
\`\`\`
Required meta fields: name, description. Optional: whenToUse (shown in the workflow list), phases. phase() titles are matched to meta.phases by exact string; a phase() with no matching entry gets its own progress group.

## Script body hooks
- \`agent(prompt, opts?)\`: Promise<any> — spawn a subagent. Without schema, returns its final text as a string. With \`{ schema }\` (a JSON Schema object), the subagent is forced to call a StructuredOutput tool and agent() returns the validated object. Returns null if the agent is skipped (filter with .filter(Boolean)). opts: \`label\` (display label), \`phase\` (assign to a progress group — use inside parallel/pipeline stages to avoid racing the global phase() state), \`model\` (override; default omitted — inherits the main-loop model), \`agentType\` (use a custom registered agent instead of the default workflow subagent), \`isolation: 'worktree'\` (run in a fresh git worktree — EXPENSIVE ~200-500ms + disk; ONLY when agents mutate files in parallel and would conflict).
- \`pipeline(items, stage1, stage2, ...)\`: Promise<any[]> — run each item through all stages independently, NO barrier between stages. Item A can be in stage 3 while item B is in stage 1. THE DEFAULT for multi-stage work. Every stage callback receives (prevResult, originalItem, index). A stage that throws drops that item to null and skips its remaining stages.
- \`parallel(thunks)\`: Promise<any[]> — run thunks concurrently. This is a BARRIER. A thunk that throws (or whose agent errors) resolves to null in the result array — the call NEVER rejects, so .filter(Boolean) before using results. Use ONLY when you genuinely need all results together.
- \`phase(title)\` — start a phase; later agent() calls group under it.
- \`log(message)\` — emit a progress message.
- \`args\` — the value passed as Workflow's \`args\` input, verbatim.
- \`budget\` — { total: number|null, spent(): number, remaining(): number }. total is null when no token target is set (then remaining() is Infinity); spent() reports output tokens used so far. Use for logging/observability.
- \`workflow(nameOrRef, args?)\`: Promise<any> — run another saved workflow inline as a sub-step and return its result. Pass a name (a saved workflow in .claude/workflows/) or { scriptPath }. The child shares this run's concurrency cap, agent counter, abort signal, and token budget. Nesting is one level only — workflow() inside a child throws.

DEFAULT TO pipeline(). Reach for a barrier (parallel between stages) only when stage N genuinely needs ALL of stage N-1 (dedup/merge across the full set, early-exit on zero, or "compare against the other findings"). "I need to flatten/map/filter first" is not a barrier — do it inside a pipeline stage.

Concurrent agent() calls are capped per workflow (excess queue and run as slots free up); you can still pass 100 items to parallel()/pipeline() and they all complete. Total agent count is capped at ${String(MAX_WORKFLOW_TOTAL_AGENTS)} as a runaway backstop.

Scripts are plain JavaScript, NOT TypeScript (no type annotations/interfaces/generics). Standard built-ins (JSON, Math, Array) are available — EXCEPT Date.now() / Math.random() / argless new Date(), which are rejected (they break resume); pass timestamps via args, and vary randomness by index.

## Quality patterns (compose freely)
- Adversarial verify: spawn N skeptics per finding, each prompted to refute; keep only if a majority fail to refute.
- Judge panel: generate N independent attempts from different angles, score with parallel judges, synthesize from the winner.
- Loop-until-dry: keep spawning finders until K consecutive rounds find nothing new (simple counters miss the tail).
- Multi-modal sweep: parallel agents each searching a different way (by-name, by-content, by-time).
- No silent caps: if you bound coverage (top-N, sampling), log() what was dropped.

## Canonical example — pipeline by default, each dimension verifies as soon as its review completes
\`\`\`
const results = await pipeline(
  DIMENSIONS,
  d => agent(d.prompt, { label: 'review:' + d.key, phase: 'Review', schema: FINDINGS_SCHEMA }),
  review => parallel(review.findings.map(f => () =>
    agent('Adversarially verify: ' + f.title, { label: 'verify:' + f.file, phase: 'Verify', schema: VERDICT_SCHEMA })
      .then(v => Object.assign({}, f, { verdict: v }))
  ))
)
const confirmed = results.flat().filter(Boolean).filter(f => f.verdict && f.verdict.isReal)
return { confirmed }
\`\`\`

Available predefined workflows:
${listing}

Input precedence:
- \`scriptPath\` takes precedence over \`script\` and \`name\`.
- \`script\` runs an inline self-contained script.
- \`name\` resolves a predefined workflow (built-in or from \`.claude/workflows/*.js\`).

## Resume
The result includes a runId. To resume after a stop or a script edit, relaunch with { scriptPath, resumeFromRunId } — the longest unchanged prefix of agent() calls returns cached results instantly; the first edited/new call and everything after it run live. Same script + same args → 100% cache hit. Use \`resumeFromRunId\` only for a prior same-session run that has been stopped or completed.`
})

function runWorkflowScript(params: {
  body: string
  filename: string
  args: WorkflowArgs
  agent: (prompt: unknown, options?: unknown) => Promise<unknown>
  parallel: (items: unknown) => Promise<unknown[]>
  pipeline: (items: unknown, ...steps: unknown[]) => Promise<unknown[]>
  phase: (title: unknown) => string
  budget: { total: number | null; spent: () => number; remaining: () => number }
  workflow: (nameOrRef: unknown, args?: unknown) => Promise<unknown>
  narrate?: (message: string) => void
}): Promise<unknown> {
  const log = (...values: unknown[]) => {
    const message = values.map(value => formatWorkflowValue(value)).join(' ')
    logForDebugging(`[Workflow] ${message}`)
    // Surface log() to the user as a /workflows narrator line.
    params.narrate?.(message)
  }
  const sandbox = createContext({
    args: params.args,
    agent: params.agent,
    parallel: params.parallel,
    pipeline: params.pipeline,
    phase: params.phase,
    budget: params.budget,
    workflow: params.workflow,
    log,
    URL,
    console: {
      log,
    },
  })
  const script = new Script(`(async () => {\n${params.body}\n})()`, {
    filename: params.filename,
  })
  return Promise.resolve(script.runInContext(sandbox, { timeout: 1000 }))
}

export const WorkflowTool = buildTool({
  name: WORKFLOW_TOOL_NAME,
  searchHint: 'run a dynamic workflow',
  maxResultSizeChars: 100_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'Workflow'
  },
  async description(input) {
    const identity = workflowIdentity(input)
    return identity ? `Run workflow: ${identity}` : 'Run workflow'
  },
  async prompt() {
    return getWorkflowPrompt(getProjectRoot())
  },
  isReadOnly() {
    return false
  },
  isConcurrencySafe() {
    return true
  },
  toAutoClassifierInput(input) {
    return workflowIdentity(input)
  },
  getToolUseSummary(input) {
    return workflowIdentity(input) || null
  },
  getActivityDescription(input) {
    const identity = workflowIdentity(input)
    return identity ? `Running workflow ${identity}` : 'Running workflow'
  },
  renderToolUseMessage(input) {
    return `dynamic workflow: ${workflowDisplayName(input)}`
  },
  renderToolResultMessage() {
    return React.createElement(
      MessageResponse,
      { height: 1 },
      React.createElement(
        Box,
        { flexDirection: 'row' },
        React.createElement(Text, { dimColor: true }, 'Running in background'),
        React.createElement(Text, { dimColor: true }, ' - /workflows to monitor and save'),
      ),
    )
  },
  async validateInput(input): Promise<ValidationResult> {
    const hasScriptPath = Boolean(input.scriptPath?.trim())
    const hasScript = Boolean(input.script?.trim())
    const hasName = Boolean(input.name?.trim())
    const resumeFromRunId = input.resumeFromRunId?.trim()
    if (!hasScriptPath && !hasScript && !hasName) {
      return {
        result: false,
        message: 'Workflow requires scriptPath, script, or name',
        errorCode: 1,
      }
    }

    if (hasScriptPath) {
      try {
        parseWorkflowScript(
          await readFile(resolve(getCwd(), input.scriptPath!), 'utf8'),
        )
      } catch (error) {
        return {
          result: false,
          message: errorMessage(error),
          errorCode: 3,
        }
      }
    } else if (hasName) {
      const workflow = await resolveWorkflowByName(
        getProjectRoot(),
        normalizeWorkflowName(input.name!),
      )
      if (!workflow) {
        return {
          result: false,
          message: `Unknown workflow: ${normalizeWorkflowName(input.name!)}`,
          errorCode: 4,
        }
      }
    } else if (hasScript) {
      let body: string
      try {
        body = parseWorkflowScript(input.script!).body
      } catch (error) {
        return {
          result: false,
          message: errorMessage(error),
          errorCode: 2,
        }
      }
      // Determinism guard (mirrors official): reject non-deterministic builtins
      // in the script body so resumeFromRunId cache keys stay stable.
      if (
        /\bDate\s*\.\s*now\b|\bMath\s*\.\s*random\b|\bnew\s+Date\s*\(\s*\)/.test(
          body,
        )
      ) {
        return {
          result: false,
          message:
            'Workflow scripts must be deterministic: Date.now()/Math.random()/new Date() are unavailable (breaks resume). Stamp results after the workflow returns, or pass timestamps via args.',
          errorCode: 7,
        }
      }
    }

    if (resumeFromRunId && !workflowRunCaches.has(resumeFromRunId)) {
      return {
        result: false,
        message: `Unknown workflow run: ${resumeFromRunId}`,
        errorCode: 5,
      }
    }

    if (resumeFromRunId) {
      const priorCache = workflowRunCaches.get(resumeFromRunId)
      if (hasScriptPath && priorCache?.scriptPath) {
        const requestedScriptPath = resolve(getCwd(), input.scriptPath!)
        if (requestedScriptPath !== priorCache.scriptPath) {
          return {
            result: false,
            message:
              'resumeFromRunId must reference a run created from the same workflow scriptPath',
            errorCode: 6,
          }
        }
      }
    }

    return { result: true }
  },
  async checkPermissions(input, context): Promise<PermissionDecision> {
    const identity = workflowIdentity(input)
    const permissionContext = context.getAppState().toolPermissionContext

    const matchesRule = (ruleContent: string): boolean => {
      const normalized = normalizeWorkflowName(ruleContent)
      return normalized === identity || normalized === '*'
    }

    const denyRules = getRuleByContentsForTool(
      permissionContext,
      WorkflowTool,
      'deny',
    )
    for (const [ruleContent, rule] of denyRules.entries()) {
      if (matchesRule(ruleContent)) {
        return {
          behavior: 'deny',
          message: 'Workflow execution blocked by permission rules',
          decisionReason: { type: 'rule', rule },
        }
      }
    }

    const allowRules = getRuleByContentsForTool(
      permissionContext,
      WorkflowTool,
      'allow',
    )
    for (const [ruleContent, rule] of allowRules.entries()) {
      if (matchesRule(ruleContent)) {
        return {
          behavior: 'allow',
          updatedInput: input,
          decisionReason: { type: 'rule', rule },
        }
      }
    }

    return {
      behavior: 'ask',
      message: identity ? `Execute workflow: ${identity}` : 'Execute workflow',
      updatedInput: input,
      suggestions: identity
        ? [
            {
              type: 'addRules',
              destination: 'localSettings',
              behavior: 'allow',
              rules: [
                {
                  toolName: WORKFLOW_TOOL_NAME,
                  ruleContent: identity,
                },
              ],
            },
          ]
        : undefined,
    }
  },
  async call(
    input,
    context,
    canUseTool,
    _parentMessage,
  ): Promise<ToolResult<Output>> {
    const loaded = await loadWorkflowScript(input)
    const { meta, body } = parseWorkflowScript(loaded.script)
    const sourceScriptPath = loaded.scriptPath
    const runId = createWorkflowRunId()
    const taskId = `w${randomUUID().replace(/-/g, '').slice(0, 8)}`
    const rootSetAppState =
      context.setAppStateForTasks ?? context.setAppState
    const description = meta.description
    const phaseTitles = meta.phases.map(phaseTitle)
    const scriptPath =
      sourceScriptPath ??
      (await persistWorkflowScript(meta.name, runId, loaded.script))
    const priorCache = input.resumeFromRunId
      ? workflowRunCaches.get(input.resumeFromRunId)
      : undefined
    const runCache: WorkflowRunCache = {
      runId,
      scriptPath,
      calls: new Map(priorCache?.calls ?? []),
    }
    workflowRunCaches.set(runId, runCache)

    let workflowPaused = false
    let pauseStartedAt: number | undefined
    let totalPausedMs = 0
    const pauseWaiters = new Set<() => void>()
    const pauseController = {
      pause(): void {
        if (workflowPaused) return
        workflowPaused = true
        pauseStartedAt = Date.now()
      },
      resume(): void {
        if (!workflowPaused) return
        if (pauseStartedAt !== undefined) {
          totalPausedMs += Math.max(0, Date.now() - pauseStartedAt)
        }
        workflowPaused = false
        pauseStartedAt = undefined
        const waiters = [...pauseWaiters]
        pauseWaiters.clear()
        waiters.forEach(resolvePaused => resolvePaused())
      },
      isPaused(): boolean {
        return workflowPaused
      },
    }
    const getPausedDurationMs = (): number =>
      totalPausedMs +
      (workflowPaused && pauseStartedAt !== undefined
        ? Math.max(0, Date.now() - pauseStartedAt)
        : 0)

    const taskState = registerWorkflowTask({
      taskId,
      runId,
      description,
      workflowName: meta.name,
      scriptPath,
      pauseController,
      phaseTitles,
      summary: description,
      agentCount: 0,
      setAppState: rootSetAppState,
      toolUseId: context.toolUseId,
    })
    void initTaskOutput(taskId)
    setWorkflowRestartHandler(
      taskId,
      () => {
        void WorkflowTool.call(
          {
            scriptPath,
            args: input.args ?? {},
            resumeFromRunId: runId,
          },
          context,
          canUseTool,
          _parentMessage,
        ).catch(error => {
          logForDebugging(
            `Failed to restart workflow ${runId}: ${errorMessage(error)}`,
          )
        })
      },
      rootSetAppState,
    )

    const workflowAbortController = taskState.abortController!
    const waitIfPaused = async (): Promise<void> => {
      while (pauseController.isPaused()) {
        if (workflowAbortController.signal.aborted) {
          throw new AbortError('Workflow was stopped')
        }

        await new Promise<void>((resolvePaused, rejectPaused) => {
          let cleanup: (() => void) | null = null
          const onResume = () => {
            cleanup?.()
            resolvePaused()
          }
          const onAbort = () => {
            cleanup?.()
            rejectPaused(new AbortError('Workflow was stopped'))
          }
          cleanup = () => {
            pauseWaiters.delete(onResume)
            workflowAbortController.signal.removeEventListener('abort', onAbort)
          }

          pauseWaiters.add(onResume)
          workflowAbortController.signal.addEventListener('abort', onAbort, {
            once: true,
          })
        })
      }
    }
    const tracker = createProgressTracker()
    const resolveActivity = createActivityDescriptionResolver(
      context.options.tools,
    )
    const progressEntries = buildInitialProgress(meta)
    let activePhaseIndex = 0
    let agentIndex = 0
    let totalToolUseCount = 0
    let totalAgentCalls = 0
    let runningAgentCount = 0
    const pendingAgentSlots: Array<{
      start: () => void
      abort: () => void
    }> = []
    let finalWorktreeResult: {
      worktreePath?: string
      worktreeBranch?: string
    } = {}

    const releaseAgentSlot = (): void => {
      runningAgentCount = Math.max(0, runningAgentCount - 1)
      const next = pendingAgentSlots.shift()
      if (!next) return

      workflowAbortController.signal.removeEventListener('abort', next.abort)
      runningAgentCount++
      next.start()
    }

    const acquireAgentSlot = async (): Promise<void> => {
      if (workflowAbortController.signal.aborted) {
        throw new AbortError('Workflow was stopped')
      }
      if (runningAgentCount < MAX_WORKFLOW_CONCURRENT_AGENTS) {
        runningAgentCount++
        return
      }

      await new Promise<void>((resolveSlot, rejectSlot) => {
        const waiter = {
          start: resolveSlot,
          abort: () => {
            const index = pendingAgentSlots.indexOf(waiter)
            if (index >= 0) pendingAgentSlots.splice(index, 1)
            rejectSlot(new AbortError('Workflow was stopped'))
          },
        }
        pendingAgentSlots.push(waiter)
        workflowAbortController.signal.addEventListener('abort', waiter.abort, {
          once: true,
        })
      })
    }

    const publishProgress = (message: string): void => {
      const progress = getProgressUpdate(tracker)
      const agentCount = progressEntries.filter(
        item => item.type === 'workflow_agent',
      ).length

      updateWorkflowTaskProgress(
        taskId,
        {
          progress,
          workflowProgress: [...progressEntries],
          summary: description,
          agentCount,
        },
        rootSetAppState,
      )

      emitTaskProgressEvent({
        taskId,
        toolUseId: context.toolUseId,
        description: message,
        startTime: taskState.startTime,
        totalTokens: getTokenCountFromTracker(tracker),
        toolUses: progress.toolUseCount,
        lastToolName: progress.lastActivity?.toolName,
        summary: description,
        workflowProgress: [...progressEntries],
      })
    }

    const setPhase = (title: unknown): string => {
      const normalizedTitle =
        typeof title === 'string' && title.trim()
          ? title.trim()
          : `Phase ${activePhaseIndex + 1}`
      const existingIndex = progressEntries.findIndex(
        item => item.type === 'workflow_phase' && item.title === normalizedTitle,
      )
      const existingPhase =
        existingIndex >= 0 ? progressEntries[existingIndex] : undefined
      activePhaseIndex =
        existingPhase && existingPhase.type === 'workflow_phase'
          ? existingPhase.index - 1
          : progressEntries.filter(item => item.type === 'workflow_phase').length
      if (existingIndex < 0) {
        progressEntries.push({
          type: 'workflow_phase',
          index: activePhaseIndex + 1,
          title: normalizedTitle,
          state: 'progress',
        })
      }
      progressEntries.forEach(item => {
        if (item.type !== 'workflow_phase') return
        if (item.index === activePhaseIndex + 1) {
          item.state = 'progress'
        } else if (item.state === 'start' || item.state === 'progress') {
          item.state = 'done'
        }
      })
      publishProgress(`Workflow phase: ${normalizedTitle}`)
      return normalizedTitle
    }

    // narrate(): script log() / console.log() lines surface as a workflow_log
    // progress entry (rendered as a /workflows narrator line) and a progress
    // event. Older log lines are capped to bound the progress payload.
    const narrate = (message: string): void => {
      progressEntries.push({
        type: 'workflow_log',
        message,
        at: Date.now(),
      })
      let seen = 0
      for (let i = progressEntries.length - 1; i >= 0; i--) {
        if (progressEntries[i]!.type === 'workflow_log') {
          seen++
          if (seen > WORKFLOW_LOG_MAX_ENTRIES) {
            progressEntries.splice(i, 1)
          }
        }
      }
      publishProgress(message)
    }

    const runWorkflowAgent = async (
      promptInput: unknown,
      rawOptions?: unknown,
    ): Promise<unknown> => {
      if (workflowAbortController.signal.aborted) {
        throw new AbortError('Workflow was stopped')
      }
      await waitIfPaused()

      const prompt = formatWorkflowValue(promptInput).trim()
      if (!prompt) {
        throw new Error('agent() prompt must be non-empty')
      }
      totalAgentCalls++
      if (totalAgentCalls > MAX_WORKFLOW_TOTAL_AGENTS) {
        throw new Error(
          `Workflow exceeded the maximum of ${MAX_WORKFLOW_TOTAL_AGENTS} agent calls`,
        )
      }

      const options = coerceWorkflowOptions(rawOptions)
      let structuredOutputTool: Tool | undefined
      if (options.schema) {
        const structuredOutput = createSyntheticOutputTool(options.schema)
        if ('error' in structuredOutput) {
          throw new Error(
            `Invalid workflow agent schema for ${options.label ?? 'agent'}: ${structuredOutput.error}`,
          )
        }
        structuredOutputTool = structuredOutput.tool
      }
      // The structured-output contract lives in the subagent system prompt
      // (fV5) + the StructuredOutput tool's input_schema, matching official —
      // the user prompt is left clean (no schema text injected).
      const agentPrompt = prompt
      const selectedAgent = resolveWorkflowAgent(
        context.options.agentDefinitions.activeAgents,
        options,
      )
      const phaseIndex =
        options.phase !== undefined
          ? meta.phases.findIndex(phase => phase.title === options.phase)
          : activePhaseIndex
      const resolvedPhaseIndex = phaseIndex >= 0 ? phaseIndex : activePhaseIndex
      const promptPreview = previewWorkflowText(prompt)
      const label = options.label ?? promptPreview
      // Effective model: explicit opts.model wins, then the phase's declared
      // model (meta.phases[i].model), then the main-loop model for display.
      const phaseModel = meta.phases[resolvedPhaseIndex]?.model
      const effectiveModel = options.model ?? phaseModel
      const resolvedModel =
        effectiveModel ?? context.options.mainLoopModel
      const cacheKey = hashWorkflowCall({
        prompt,
        options,
        model: effectiveModel,
        agentType: selectedAgent.agentType,
      })
      const cached = runCache.calls.get(cacheKey)
      const phaseNumber = resolvedPhaseIndex + 1
      const phase = meta.phases[resolvedPhaseIndex]
      const resolvedPhaseTitle = phase
        ? phaseTitle(phase, resolvedPhaseIndex)
        : undefined

      if (cached) {
        const now = Date.now()
        const entry: SdkWorkflowProgress = {
          type: 'workflow_agent',
          index: agentIndex++ + 1,
          label,
          phaseIndex: phaseNumber,
          phaseTitle: resolvedPhaseTitle,
          model: resolvedModel,
          state: 'done',
          queuedAt: now,
          startedAt: now,
          attempt: 1,
          promptPreview,
          lastProgressAt: now,
          tokens: cached.totalTokens,
          toolCalls: cached.totalToolUseCount,
          durationMs: cached.totalDurationMs,
          resultPreview: cached.content,
        }
        progressEntries.push(entry)
        totalToolUseCount += cached.totalToolUseCount
        publishProgress(`${label}: reused cached result`)
        appendTaskOutput(taskId, `## ${label} (cached)\n${cached.content}\n\n`)
        return cached.value
      }

      const transcriptSubdir = `workflows/${runId}`
      const workflowAgentContext = {
        ...context,
        getAppState: () => {
          const state = context.getAppState()
          return {
            ...state,
            toolPermissionContext: {
              ...state.toolPermissionContext,
              mode: 'acceptEdits' as const,
            },
          }
        },
      }

      let attempt = 0
      let lastAttemptReason: string | undefined
      let throttleRetried = false
      while (true) {
        attempt++
        const agentId = createAgentId('wf')
        const now = Date.now()
        const entry: SdkWorkflowProgress = {
          type: 'workflow_agent',
          index: agentIndex++ + 1,
          label,
          phaseIndex: phaseNumber,
          phaseTitle: resolvedPhaseTitle,
          agentId,
          model: resolvedModel,
          state: 'queued',
          queuedAt: now,
          attempt,
          lastAttemptReason,
          promptPreview,
          lastProgressAt: now,
        }
        progressEntries.push(entry)
        publishProgress(
          `${label}: ${lastAttemptReason ? `retrying after ${lastAttemptReason}` : 'queued'}`,
        )

        let slotAcquired = false
        let restartRequested = false
        let skipRequested = false
        let stalled = false
        let stallMessage: string | undefined
        let stallTimer: ReturnType<typeof setTimeout> | undefined
        let worktreeInfo:
          | Awaited<ReturnType<typeof createAgentWorktree>>
          | null = null
        const agentMessages: Message[] = []
        const childAbortController =
          createChildAbortController(workflowAbortController)
        let agentStartTokens = 0
        let agentStartToolUses = 0
        let structuredOutput: unknown
        let hasStructuredOutput = false

        const clearStallTimer = (): void => {
          if (stallTimer) {
            clearTimeout(stallTimer)
            stallTimer = undefined
          }
        }
        const armStallTimer = (): void => {
          clearStallTimer()
          const lastProgressAt = entry.lastProgressAt ?? Date.now()
          const remaining = Math.max(
            0,
            WORKFLOW_AGENT_STALL_MS - (Date.now() - lastProgressAt),
          )
          stallTimer = setTimeout(() => {
            if (
              workflowAbortController.signal.aborted ||
              childAbortController.signal.aborted
            ) {
              return
            }
            stalled = true
            stallMessage = `stalled — no progress for ${WORKFLOW_AGENT_STALL_MS}ms`
            entry.state = 'error'
            entry.error = stallMessage
            publishProgress(`${label}: ${stallMessage}`)
            childAbortController.abort(new Error(stallMessage))
          }, remaining)
        }

        try {
          await waitIfPaused()
          await acquireAgentSlot()
          slotAcquired = true
          await waitIfPaused()

          entry.state = 'start'
          entry.startedAt = Date.now()
          entry.lastProgressAt = entry.startedAt
          agentStartTokens = getTokenCountFromTracker(tracker)
          agentStartToolUses = getProgressUpdate(tracker).toolUseCount
          publishProgress(`${label}: ${promptPreview}`)

          setWorkflowAgentController(
            taskId,
            agentId,
            childAbortController,
            rootSetAppState,
          )
          setWorkflowAgentRestartHandler(
            taskId,
            agentId,
            () => {
              restartRequested = true
              childAbortController.abort()
            },
            rootSetAppState,
          )
          setWorkflowAgentSkipHandler(
            taskId,
            agentId,
            () => {
              skipRequested = true
              childAbortController.abort()
            },
            rootSetAppState,
          )
          setAgentTranscriptSubdir(agentId, transcriptSubdir)
          if (options.schema) {
            registerStructuredOutputEnforcement(rootSetAppState, agentId)
          }

          // Worktree isolation is opt-in (matches official: only when
          // opts.isolation === 'worktree'). Read-only/research agents run in
          // the session cwd, avoiding ~200-500ms + disk per agent.
          worktreeInfo =
            options.isolation === 'worktree'
              ? await createAgentWorktree(
                  `wf_${runId.replace(/^wf_/, '').slice(0, 8)}-${entry.index}`,
                )
              : null
          const consumeStream = async () => {
            armStallTimer()
            for await (const message of runWorkflowAgentRequest({
              agentDefinition: selectedAgent,
              prompt: agentPrompt,
              context: workflowAgentContext,
              canUseTool,
              workflowName: meta.name,
              options,
              model: effectiveModel,
              structuredOutputTool,
              agentId,
              abortController: childAbortController,
              worktreePath: worktreeInfo?.worktreePath,
              description: label,
              transcriptSubdir,
            })) {
              if (
                message.type === 'attachment' &&
                message.attachment.type === 'structured_output'
              ) {
                structuredOutput = message.attachment.data
                hasStructuredOutput = true
                break
              }
              agentMessages.push(message)
              updateProgressFromMessage(
                tracker,
                message,
                resolveActivity,
                context.options.tools,
              )
              const lastToolName = getLastToolUseName(message)
              const current = getProgressUpdate(tracker)
              const progressMessage =
                current.lastActivity?.activityDescription ??
                current.lastActivity?.toolName ??
                label
              entry.state = 'progress'
              entry.lastProgressAt = Date.now()
              entry.tokens = Math.max(
                0,
                getTokenCountFromTracker(tracker) - agentStartTokens,
              )
              entry.toolCalls = Math.max(
                0,
                current.toolUseCount - agentStartToolUses,
              )
              armStallTimer()
              publishProgress(progressMessage)
              if (lastToolName) {
                emitTaskProgressEvent({
                  taskId,
                  toolUseId: context.toolUseId,
                  description: progressMessage,
                  startTime: taskState.startTime,
                  totalTokens: getTokenCountFromTracker(tracker),
                  toolUses: current.toolUseCount,
                  lastToolName,
                  summary: description,
                  workflowProgress: [...progressEntries],
                })
              }
            }
          }

          if (worktreeInfo) {
            await runWithCwdOverride(worktreeInfo.worktreePath, consumeStream)
          } else {
            await consumeStream()
          }
          clearStallTimer()

          // User skipped this agent from /workflows: resolve to null (not an
          // error) so the script's .filter(Boolean) drops it. Mirrors official.
          if (skipRequested && !workflowAbortController.signal.aborted) {
            entry.state = 'error'
            entry.error = 'skipped by user'
            publishProgress(`${label} skipped`)
            return null
          }

          if (restartRequested && !workflowAbortController.signal.aborted) {
            entry.state = 'error'
            entry.error = 'Restarting agent'
            lastAttemptReason = 'manual restart'
            publishProgress(`${label} restarting`)
            continue
          }

          const agentFailure = getAgentFailureMessage(agentMessages)
          if (agentFailure) {
            throw new Error(agentFailure)
          }

          if (options.schema && !hasStructuredOutput) {
            throw new Error(
              `${label} did not provide structured output with ${SYNTHETIC_OUTPUT_TOOL_NAME}`,
            )
          }

          // Throttle backoff: a degraded/throttled response (no stop_reason,
          // very few output tokens, taking more than half the stall window)
          // is retried once after a sleep. Mirrors official behavior.
          if (!throttleRetried && !workflowAbortController.signal.aborted) {
            let stopReason: string | null = null
            let outputTokens: number | undefined
            for (let i = agentMessages.length - 1; i >= 0; i--) {
              const message = agentMessages[i]!
              if (message.type === 'assistant') {
                stopReason = message.message.stop_reason ?? null
                outputTokens = message.message.usage?.output_tokens
                break
              }
            }
            const elapsedMs =
              Date.now() - (entry.startedAt ?? taskState.startTime)
            const degraded =
              stopReason == null &&
              (outputTokens ?? Number.POSITIVE_INFINITY) <
                WORKFLOW_DEGRADED_OUTPUT_TOKENS &&
              elapsedMs > WORKFLOW_AGENT_STALL_MS * 0.5
            if (degraded) {
              throttleRetried = true
              lastAttemptReason = 'throttled'
              entry.state = 'error'
              entry.error = 'throttled — retrying'
              publishProgress(
                `${label}: throttled response (no stop_reason, ${outputTokens ?? '?'} output tokens in ${Math.round(elapsedMs / 1000)}s) — sleeping ${Math.round(WORKFLOW_THROTTLE_BACKOFF_MS / 1000)}s before retry`,
              )
              await sleep(
                WORKFLOW_THROTTLE_BACKOFF_MS,
                workflowAbortController.signal,
                { throwOnAbort: true },
              )
              continue
            }
          }

          const value = hasStructuredOutput
            ? structuredOutput
            : (extractPartialResult(agentMessages) ?? `${label} completed`)
          const content = formatWorkflowValue(value).trim()
          const result = {
            value,
            content,
            totalDurationMs:
              Date.now() - (entry.startedAt ?? taskState.startTime),
            totalTokens: Math.max(
              0,
              getTokenCountFromTracker(tracker) - agentStartTokens,
            ),
            totalToolUseCount: countToolUses(agentMessages),
          }
          totalToolUseCount += result.totalToolUseCount
          runCache.calls.set(cacheKey, result)
          entry.state = 'done'
          entry.durationMs = result.totalDurationMs
          entry.tokens = result.totalTokens
          entry.toolCalls = result.totalToolUseCount
          entry.resultPreview = content
          entry.lastProgressAt = Date.now()
          appendTaskOutput(taskId, `## ${label}\n${content}\n\n`)
          finalWorktreeResult = {
            ...finalWorktreeResult,
            ...(await cleanupWorktreeIfNeeded(worktreeInfo)),
          }
          worktreeInfo = null
          publishProgress(`${label} completed`)
          return value
        } catch (error) {
          clearStallTimer()
          // User skip aborts this agent: resolve to null instead of erroring,
          // so the script's .filter(Boolean) drops it (matches official).
          if (skipRequested && !workflowAbortController.signal.aborted) {
            entry.state = 'error'
            entry.error = 'skipped by user'
            publishProgress(`${label} skipped`)
            return null
          }
          if (restartRequested && !workflowAbortController.signal.aborted) {
            entry.state = 'error'
            entry.error = 'Restarting agent'
            lastAttemptReason = 'manual restart'
            publishProgress(`${label} restarting`)
            continue
          }

          if (stalled && !workflowAbortController.signal.aborted) {
            const message =
              stallMessage ?? `stalled — no progress for ${WORKFLOW_AGENT_STALL_MS}ms`
            entry.state = 'error'
            entry.error = message
            if (attempt < MAX_WORKFLOW_AGENT_ATTEMPTS) {
              lastAttemptReason = message
              publishProgress(`${label}: retrying after ${message}`)
              continue
            }
          }

          entry.state = 'error'
          entry.error =
            workflowAbortController.signal.aborted && error instanceof AbortError
              ? 'Workflow was stopped'
              : errorMessage(error)
          publishProgress(`${label} error`)
          throw error
        } finally {
          clearStallTimer()
          if (slotAcquired) {
            releaseAgentSlot()
          }
          if (worktreeInfo) {
            finalWorktreeResult = {
              ...finalWorktreeResult,
              ...(await cleanupWorktreeIfNeeded(worktreeInfo)),
            }
          }
          clearWorkflowAgentController(taskId, agentId, rootSetAppState)
          if (options.schema) {
            clearSessionHooks(rootSetAppState, agentId)
          }
          clearInvokedSkillsForAgent(agentId)
          clearDumpState(agentId)
          clearAgentTranscriptSubdir(agentId)
        }
      }
    }

    // parallel(): BARRIER over thunks. Mirrors official semantics — a thunk
    // that throws (or whose agent errors) resolves to `null` in the result
    // array; the call itself NEVER rejects, so scripts can `.filter(Boolean)`.
    // A genuine workflow abort hangs (the outer abort race tears it down).
    const runParallel = async (items: unknown): Promise<unknown[]> => {
      if (workflowAbortController.signal.aborted) {
        return new Promise<never>(() => {})
      }
      if (!Array.isArray(items)) {
        throw new Error('parallel() expects an array of functions')
      }
      if (items.length === 0) return []
      const settled = await Promise.allSettled(
        items.map(async item => {
          await waitIfPaused()
          return typeof item === 'function'
            ? await (item as () => unknown)()
            : item
        }),
      )
      if (workflowAbortController.signal.aborted) {
        return new Promise<never>(() => {})
      }
      return settled.map((result, index) => {
        if (result.status === 'fulfilled') return result.value
        const message =
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason)
        publishProgress(`parallel[${index}] failed: ${message}`)
        return null
      })
    }

    // pipeline(): NO barrier between stages — each item flows through all stages
    // independently. Every stage callback receives (prevResult, originalItem,
    // index). A stage that throws drops that item to `null` and skips its
    // remaining stages; a `null` result short-circuits the rest of the chain.
    // Like parallel(), this never rejects.
    const runPipeline = async (
      items: unknown,
      ...steps: unknown[]
    ): Promise<unknown[]> => {
      if (workflowAbortController.signal.aborted) {
        return new Promise<never>(() => {})
      }
      if (!Array.isArray(items)) {
        throw new Error('pipeline() expects an array as the first argument')
      }
      if (items.length === 0) return []
      if (steps.length === 0 || steps.some(step => typeof step !== 'function')) {
        throw new Error('pipeline() expects one or more step functions')
      }
      const settled = await Promise.allSettled(
        items.map(async (item, index) => {
          let current: unknown = item
          for (const step of steps) {
            await waitIfPaused()
            if (current === null) break
            current = await (
              step as (
                value: unknown,
                item: unknown,
                index: number,
              ) => unknown
            )(current, item, index)
          }
          return current
        }),
      )
      if (workflowAbortController.signal.aborted) {
        return new Promise<never>(() => {})
      }
      return settled.map((result, index) => {
        if (result.status === 'fulfilled') return result.value
        const message =
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason)
        publishProgress(`pipeline[${index}] failed: ${message}`)
        return null
      })
    }

    // budget global. micro has no per-turn token target (official's "+500k"
    // directive), so total is null and remaining() is Infinity — matching the
    // official no-target semantics. spent() reports this workflow's output
    // tokens so far so scripts can log/observe progress.
    const budgetBaseline = getTokenCountFromTracker(tracker)
    const workflowBudget = Object.freeze({
      total: null as number | null,
      spent: (): number =>
        Math.max(0, getTokenCountFromTracker(tracker) - budgetBaseline),
      remaining: (): number => Infinity,
    })

    // workflow() injected into a CHILD's sandbox: nesting is one level only.
    const childWorkflowBlocked = async (): Promise<never> => {
      throw new Error(
        'workflow() nesting is one level only: a workflow() call inside a child workflow is not allowed',
      )
    }

    // workflow(nameOrRef, args): run another saved/scriptPath workflow inline as
    // a sub-step and return its result. The child shares this run's agent/
    // parallel/pipeline/phase hooks, concurrency cap, agent counter, abort
    // signal, and token budget. Sibling child workflows may run concurrently;
    // the child's own workflow() is blocked (one level deep).
    const runChildWorkflow = async (
      nameOrRef: unknown,
      childArgs?: unknown,
    ): Promise<unknown> => {
      if (workflowAbortController.signal.aborted) {
        return new Promise<never>(() => {})
      }
      let childScript: string
      let childName: string
      if (typeof nameOrRef === 'string' && nameOrRef.trim()) {
        const child = await resolveWorkflowByName(
          getProjectRoot(),
          normalizeWorkflowName(nameOrRef),
        )
        if (!child) {
          throw new Error(`workflow(): unknown workflow "${nameOrRef}"`)
        }
        childScript = child.script
        childName = child.name
      } else if (
        nameOrRef &&
        typeof nameOrRef === 'object' &&
        typeof (nameOrRef as { scriptPath?: unknown }).scriptPath === 'string'
      ) {
        const childPath = resolve(
          getCwd(),
          (nameOrRef as { scriptPath: string }).scriptPath,
        )
        childScript = await readFile(childPath, 'utf8')
        childName = basename(childPath, '.js')
      } else {
        throw new Error(
          'workflow() expects a workflow name string or { scriptPath }',
        )
      }
      let childBody: string
      try {
        childBody = parseWorkflowScript(childScript).body
      } catch (error) {
        throw new Error(
          `workflow("${childName}"): invalid child script: ${errorMessage(error)}`,
        )
      }
      narrate(`▸ ${childName}: starting nested workflow`)
      return runWorkflowScript({
        body: childBody,
        filename: `workflow:${childName}`,
        args: (childArgs ?? {}) as WorkflowArgs,
        agent: runWorkflowAgent,
        parallel: runParallel,
        pipeline: runPipeline,
        phase: setPhase,
        budget: workflowBudget,
        workflow: childWorkflowBlocked,
        narrate,
      })
    }

    const executeWorkflow = async (): Promise<void> => {
      publishProgress(`Starting workflow ${meta.name}`)
      try {
        await waitIfPaused()
        const result = await runWorkflowScript({
          body,
          filename: scriptPath,
          args: input.args ?? {},
          agent: runWorkflowAgent,
          parallel: runParallel,
          pipeline: runPipeline,
          phase: setPhase,
          budget: workflowBudget,
          workflow: runChildWorkflow,
          narrate,
        })

        progressEntries.forEach(item => {
          if (item.type === 'workflow_log') return
          if (item.type === 'workflow_phase') {
            if (
              item.state === 'start' ||
              item.state === 'progress' ||
              item.state === undefined
            ) {
              item.state = 'done'
            }
            return
          }
          if (
            item.state === 'queued' ||
            item.state === 'start' ||
            item.state === 'progress'
          ) {
            item.state = 'done'
          }
        })

        const finalMessage =
          formatWorkflowValue(result).trim() ||
          `Workflow "${meta.name}" completed`
        const totalDurationMs =
          Date.now() - taskState.startTime - getPausedDurationMs()
        const totalTokens = getTokenCountFromTracker(tracker)
        appendTaskOutput(taskId, `# Workflow result\n${finalMessage}\n`)
        publishProgress(finalMessage)
        completeWorkflowTask(
          taskId,
          {
            runId,
            content: finalMessage,
            totalDurationMs,
            totalTokens,
            totalToolUseCount,
            scriptPath,
          },
          rootSetAppState,
        )
        enqueueWorkflowNotification({
          taskId,
          workflowName: meta.name,
          description,
          status: 'completed',
          setAppState: rootSetAppState,
          finalMessage,
          usage: {
            totalTokens,
            toolUses: totalToolUseCount,
            durationMs: totalDurationMs,
          },
          toolUseId: context.toolUseId,
          ...finalWorktreeResult,
        })
      } catch (error) {
        if (error instanceof AbortError) {
          progressEntries.forEach(item => {
            if (item.type === 'workflow_log') return
            if (item.type === 'workflow_phase') {
              if (item.state === 'start' || item.state === 'progress') {
                item.state = 'error'
              }
              return
            }
            if (
              item.state === 'queued' ||
              item.state === 'start' ||
              item.state === 'progress'
            ) {
              item.state = 'error'
              item.error = 'Workflow was stopped'
            }
          })
          publishProgress(`Workflow "${meta.name}" was stopped`)
          killWorkflowTask(taskId, rootSetAppState)
          enqueueWorkflowNotification({
            taskId,
            workflowName: meta.name,
            description,
            status: 'killed',
            setAppState: rootSetAppState,
            toolUseId: context.toolUseId,
            ...finalWorktreeResult,
          })
          return
        }

        const message = errorMessage(error)
        progressEntries.forEach(item => {
          if (item.type === 'workflow_log') return
          if (item.type === 'workflow_phase') {
            if (item.state === 'start' || item.state === 'progress') {
              item.state = 'error'
            }
            return
          }
          if (
            item.state === 'queued' ||
            item.state === 'start' ||
            item.state === 'progress'
          ) {
            item.state = 'error'
            item.error = message
          }
        })
        publishProgress(message)
        failWorkflowTask(taskId, 'workflow', message, rootSetAppState)
        enqueueWorkflowNotification({
          taskId,
          workflowName: meta.name,
          description,
          status: 'failed',
          error: message,
          setAppState: rootSetAppState,
          toolUseId: context.toolUseId,
          ...finalWorktreeResult,
        })
      }
    }

    void executeWorkflow()

    const transcriptDir = join(
      dirname(getTranscriptPath()),
      getSessionId(),
      'subagents',
      'workflows',
      runId,
    )
    return {
      data: {
        status: 'async_launched',
        taskId,
        runId,
        summary: description,
        transcriptDir,
        scriptPath,
        ...(priorCache
          ? { warning: `Resuming from prior workflow run ${priorCache.runId}` }
          : {}),
      },
    }
  },
  mapToolResultToToolResultBlockParam(data, toolUseID) {
    const scriptPathLiteral = data.scriptPath
      ? JSON.stringify(data.scriptPath)
      : undefined
    const resumeCall =
      data.scriptPath && data.runId
        ? `Workflow({scriptPath: ${scriptPathLiteral}, resumeFromRunId: ${JSON.stringify(data.runId)}})`
        : undefined
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: [
        `Workflow launched in background. Task ID: ${data.taskId}`,
        data.summary ? `Summary: ${data.summary}` : null,
        data.transcriptDir ? `Transcript dir: ${data.transcriptDir}` : null,
        data.scriptPath ? `Script file: ${data.scriptPath}` : null,
        data.scriptPath
          ? `(Edit this file with Write/Edit and re-invoke Workflow with {scriptPath: ${scriptPathLiteral}} to iterate without resending the script.)`
          : null,
        data.runId ? `Run ID: ${data.runId}` : null,
        resumeCall
          ? `To resume after editing the script: ${resumeCall} - completed agents return cached results.`
          : null,
        data.warning ? `Warning: ${data.warning}` : null,
        '',
        'You will be notified when it completes. Use /workflows to watch live progress.',
      ]
        .filter(line => line !== null && line !== undefined)
        .join('\n'),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
