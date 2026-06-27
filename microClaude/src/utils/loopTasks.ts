import { randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import {
  addSessionCronTask,
  getProjectRoot,
  getScheduledTasksEnabled,
  getSessionCronTasks,
  replaceSessionCronTasks,
  setScheduledTasksEnabled,
  type SessionCronTask,
} from '../bootstrap/state.js'
import type { AgentId } from '../types/ids.js'
import type { Message, MessageOrigin } from '../types/message.js'
import type { QueuedCommand } from '../types/textInputTypes.js'
import { cronToHuman } from './cron.js'
import { persistSessionLoopTasks } from './sessionLoopTasks.js'

export const LOOP_CONTROL_TOOL_NAME = 'LoopControl'
export const LOOP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
export const LOOP_MAX_AGE_DAYS = LOOP_MAX_AGE_MS / (24 * 60 * 60 * 1000)
export const LOOP_MAINTENANCE_PROMPT_MAX_BYTES = 25_000
export const LOOP_PROVIDER_FALLBACK_INTERVAL = '10m'

const LOOP_MAINTENANCE_PLACEHOLDER = '<maintenance prompt>'

const DEFAULT_MAINTENANCE_PROMPT = `You are running a maintenance pass for the current Claude Code session.

Use the existing conversation, todos, repo state, and recent tool results to decide what is actually useful now.

Do:
- Continue clearly unfinished work when the next step is obvious.
- If this is a git repo, check lightweight project health that matters for the current work: branch state, failing tests, CI/review signals, or merge conflicts when those are already in scope.
- If there is no active task, do one bounded maintenance action such as finding a small bug, removing a clear simplification, or verifying a known risk.
- Keep the pass short and report what changed or what you checked.

Do not:
- Start a large new feature, broad refactor, or speculative cleanup.
- Take irreversible or shared actions such as committing, pushing, deleting data, changing remotes, or altering permissions unless the user already authorized that action.
- Loop just to stay busy.

If nothing useful needs action, say that no maintenance action is needed and complete the loop.`

export type LoopPromptSource = 'explicit' | 'maintenance'
export type LoopMode = 'fixed' | 'dynamic'

export type ParsedLoopCommand = {
  interval?: string
  prompt: string
  promptSource: LoopPromptSource
  mode: LoopMode
}

export type LoopIntervalSchedule = {
  interval: string
  normalizedInterval: string
  cron: string
  humanSchedule: string
  rounded: boolean
  roundingMessage?: string
}

export type LoopMaintenancePrompt = {
  prompt: string
  source: 'project' | 'user' | 'default'
  path?: string
  truncated: boolean
}

export type LoopOrigin = Extract<MessageOrigin, { kind: 'loop' }>

export function parseLoopCommand(args: string): ParsedLoopCommand {
  const trimmed = args.trim()
  if (!trimmed) {
    return {
      prompt: LOOP_MAINTENANCE_PLACEHOLDER,
      promptSource: 'maintenance',
      mode: 'dynamic',
    }
  }

  const leading = trimmed.match(/^(\d+[smhd])(?:\s+([\s\S]*))?$/i)
  if (leading) {
    const interval = normalizeIntervalToken(leading[1]!)
    const prompt = (leading[2] ?? '').trim()
    return {
      interval,
      prompt: prompt || LOOP_MAINTENANCE_PLACEHOLDER,
      promptSource: prompt ? 'explicit' : 'maintenance',
      mode: 'fixed',
    }
  }

  const trailing = trimmed.match(
    /^([\s\S]*?)\s+every\s+(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)$/i,
  )
  if (trailing && trailing[1]!.trim()) {
    return {
      interval: normalizeIntervalToken(`${trailing[2]}${normalizeUnit(trailing[3]!)}`),
      prompt: trailing[1]!.trim(),
      promptSource: 'explicit',
      mode: 'fixed',
    }
  }

  return {
    prompt: trimmed,
    promptSource: 'explicit',
    mode: 'dynamic',
  }
}

export function intervalToSchedule(interval: string): LoopIntervalSchedule {
  const match = interval.trim().toLowerCase().match(/^(\d+)([smhd])$/)
  if (!match) {
    throw new Error(`Invalid loop interval '${interval}'. Use Ns, Nm, Nh, or Nd.`)
  }

  const rawValue = Number(match[1])
  const unit = match[2] as 's' | 'm' | 'h' | 'd'
  if (!Number.isInteger(rawValue) || rawValue <= 0) {
    throw new Error(`Invalid loop interval '${interval}'. Interval must be positive.`)
  }

  let normalizedMinutes: number
  if (unit === 's') {
    normalizedMinutes = Math.ceil(rawValue / 60)
  } else if (unit === 'm') {
    normalizedMinutes = rawValue
  } else if (unit === 'h') {
    normalizedMinutes = rawValue * 60
  } else {
    if (rawValue > 31) {
      throw new Error(`Invalid loop interval '${interval}'. Day intervals must be 31 days or less.`)
    }
    const normalizedInterval = `${rawValue}d`
    return {
      interval,
      normalizedInterval,
      cron: `0 0 */${rawValue} * *`,
      humanSchedule: rawValue === 1 ? 'every day' : `every ${rawValue} days`,
      rounded: false,
    }
  }

  const cleanMinutes = nearestCleanMinuteInterval(normalizedMinutes)
  const rounded = cleanMinutes !== normalizedMinutes
  const normalizedInterval = minutesToInterval(cleanMinutes)
  const cron = cleanMinutes < 60
    ? `*/${cleanMinutes} * * * *`
    : cleanMinutes < 24 * 60
      ? `0 */${cleanMinutes / 60} * * *`
      : '0 0 * * *'
  const humanSchedule = cronToHuman(cron)
  return {
    interval,
    normalizedInterval,
    cron,
    humanSchedule,
    rounded,
    ...(rounded
      ? {
          roundingMessage: `Requested ${interval} does not map cleanly to cron; using ${normalizedInterval} (${humanSchedule}).`,
        }
      : {}),
  }
}

export async function createFixedLoopTask(options: {
  schedule: LoopIntervalSchedule
  prompt: string
  promptSource: LoopPromptSource
  agentId?: AgentId
}): Promise<SessionCronTask> {
  const task: SessionCronTask = {
    id: randomUUID().slice(0, 8),
    cron: options.schedule.cron,
    prompt:
      options.promptSource === 'maintenance'
        ? LOOP_MAINTENANCE_PLACEHOLDER
        : options.prompt,
    createdAt: Date.now(),
    recurring: true,
    source: 'loop',
    loopMode: 'fixed',
    promptSource: options.promptSource,
    ...(options.agentId ? { agentId: options.agentId } : {}),
  }
  addSessionCronTask(task)
  setScheduledTasksEnabled(true)
  await persistSessionLoopTasks()
  return task
}

export async function createDynamicLoopTask(options: {
  prompt: string
  promptSource: LoopPromptSource
  agentId?: AgentId
}): Promise<SessionCronTask> {
  const createdAt = Date.now()
  const task: SessionCronTask = {
    id: randomUUID().slice(0, 8),
    prompt:
      options.promptSource === 'maintenance'
        ? LOOP_MAINTENANCE_PLACEHOLDER
        : options.prompt,
    createdAt,
    recurring: true,
    source: 'loop',
    loopMode: 'dynamic',
    promptSource: options.promptSource,
    awaitingControlSince: createdAt,
    ...(options.agentId ? { agentId: options.agentId } : {}),
  }
  addSessionCronTask(task)
  setScheduledTasksEnabled(true)
  await persistSessionLoopTasks()
  return task
}

export async function continueDynamicLoopTask(options: {
  id: string
  delayMinutes: number
  reason?: string
  now?: number
}): Promise<SessionCronTask | null> {
  const now = options.now ?? Date.now()
  const nextFireAt = now + options.delayMinutes * 60 * 1000
  let updated: SessionCronTask | null = null
  replaceSessionCronTasks(
    getSessionCronTasks().map(task => {
      if (!isDynamicLoopTask(task) || task.id !== options.id) return task
      const { awaitingControlSince: _awaitingControlSince, ...rest } = task
      updated = {
        ...rest,
        nextFireAt,
        lastDelayMinutes: options.delayMinutes,
        ...(options.reason ? { lastDelayReason: options.reason } : {}),
      }
      return updated
    }),
  )
  if (!updated) return null
  setScheduledTasksEnabled(true)
  await persistSessionLoopTasks()
  return updated
}

export async function completeLoopTask(id: string): Promise<boolean> {
  const removed = removeLoopTasksFromState(new Set([id]))
  if (removed === 0) return false
  await persistSessionLoopTasks()
  return true
}

export async function completeDynamicLoopTasksIfUnscheduled(
  ids: readonly string[],
): Promise<string[]> {
  if (ids.length === 0) return []
  const idSet = new Set(ids)
  const completed = getSessionCronTasks()
    .filter(
      task =>
        idSet.has(task.id) &&
        isDynamicLoopTask(task) &&
        typeof task.nextFireAt !== 'number' &&
        typeof task.awaitingControlSince === 'number',
    )
    .map(task => task.id)
  if (completed.length === 0) return []
  removeLoopTasksFromState(new Set(completed))
  await persistSessionLoopTasks()
  return completed
}

export async function completeDynamicLoopTasksAfterTurn(options: {
  messages: readonly Message[]
  taskIds?: Iterable<string>
}): Promise<string[]> {
  const ids = new Set(options.taskIds ?? [])
  for (const id of getLoopTaskIdsFromMessages(options.messages)) {
    ids.add(id)
  }
  return completeDynamicLoopTasksIfUnscheduled([...ids])
}

export async function cancelPendingLoopWakeups(
  ids?: readonly string[],
): Promise<number> {
  const idSet = ids && ids.length > 0 ? new Set(ids) : undefined
  const removed = removeLoopTasksFromState(idSet)
  if (removed === 0) return 0
  await persistSessionLoopTasks()
  return removed
}

export function hasPendingLoopWakeups(): boolean {
  return getSessionCronTasks().some(isLoopTask)
}

export function markDynamicLoopTaskFired(
  id: string,
  firedAt: number,
): boolean {
  let changed = false
  replaceSessionCronTasks(
    getSessionCronTasks().map(task => {
      if (!isDynamicLoopTask(task) || task.id !== id) return task
      changed = true
      const { nextFireAt: _nextFireAt, ...rest } = task
      return { ...rest, lastFiredAt: firedAt, awaitingControlSince: firedAt }
    }),
  )
  return changed
}

export function expireLoopTasks(now: number = Date.now()): string[] {
  const expired = getSessionCronTasks()
    .filter(task => isLoopTask(task) && isLoopTaskExpired(task, now))
    .map(task => task.id)
  if (expired.length === 0) return []
  removeLoopTasksFromState(new Set(expired))
  return expired
}

export function isLoopTask(task: Partial<SessionCronTask>): task is SessionCronTask & {
  source: 'loop'
} {
  return task.source === 'loop'
}

export function isFixedLoopTask(task: Partial<SessionCronTask>): task is SessionCronTask & {
  source: 'loop'
  loopMode: 'fixed'
  cron: string
} {
  return isLoopTask(task) && task.loopMode === 'fixed' && typeof task.cron === 'string'
}

export function isDynamicLoopTask(task: Partial<SessionCronTask>): task is SessionCronTask & {
  source: 'loop'
  loopMode: 'dynamic'
} {
  return isLoopTask(task) && task.loopMode === 'dynamic'
}

export function isLoopTaskExpired(
  task: Pick<SessionCronTask, 'createdAt' | 'source'>,
  now: number = Date.now(),
): boolean {
  return task.source === 'loop' && now - task.createdAt >= LOOP_MAX_AGE_MS
}

export function isLoopQueuedCommand(cmd: QueuedCommand): boolean {
  return cmd.origin?.kind === 'loop'
}

export function getLoopTaskIdFromQueuedCommand(
  cmd: QueuedCommand,
): string | undefined {
  return cmd.origin?.kind === 'loop' ? cmd.origin.taskId : undefined
}

export function createLoopOrigin(task: SessionCronTask): LoopOrigin {
  return { kind: 'loop', taskId: task.id }
}

export function getLoopTaskIdsFromQueuedCommands(
  commands: readonly QueuedCommand[],
): string[] {
  const ids = new Set<string>()
  for (const command of commands) {
    const id = getLoopTaskIdFromQueuedCommand(command)
    if (id) ids.add(id)
  }
  return [...ids]
}

export function getLoopTaskIdsFromMessages(
  messages: readonly Message[],
): string[] {
  const ids = new Set<string>()
  for (const message of messages) {
    if (message.type !== 'user') continue
    if (message.origin?.kind === 'loop') {
      ids.add(message.origin.taskId)
    }
    const text = getUserMessageText(message)
    if (
      !text.includes('# /loop started') &&
      !text.includes('# /loop wake-up')
    ) {
      continue
    }
    for (const match of text.matchAll(/\bLoop ID:\s*([A-Za-z0-9_-]+)/g)) {
      if (match[1]) ids.add(match[1])
    }
  }
  return [...ids]
}

export function buildLoopStartPrompt(options: {
  task: SessionCronTask
  parsed: ParsedLoopCommand
  schedule?: LoopIntervalSchedule
  fallbackReason?: string
}): string {
  const { task, parsed, schedule, fallbackReason } = options
  const taskPrompt = getLoopTaskPrompt(task)
  const scheduleLine =
    task.loopMode === 'dynamic'
      ? 'Dynamic loop: choose the next wake-up delay after each iteration, between 1 minute and 1 hour.'
      : `Fixed loop: ${schedule?.humanSchedule ?? (task.cron ? cronToHuman(task.cron) : 'scheduled')}.`
  const roundingLine = schedule?.roundingMessage
    ? `\n${schedule.roundingMessage}`
    : ''
  const fallbackLine = fallbackReason ? `\n${fallbackReason}` : ''
  const maintenanceLine =
    parsed.promptSource === 'maintenance'
      ? '\nThis loop uses the maintenance prompt. Project .claude/loop.md overrides user ~/.claude/loop.md; the file is read again each iteration and truncated at 25KB.'
      : ''

  return `# /loop started

Loop ID: ${task.id}
${scheduleLine}
Session-scoped loops auto-expire after ${LOOP_MAX_AGE_DAYS} days. Press Esc while the loop is waiting to cancel the pending wake-up.${roundingLine}${fallbackLine}${maintenanceLine}

## Run this iteration now

${taskPrompt}

${buildLoopExecutionInstructions(task)}`
}

export function buildLoopFirePrompt(task: SessionCronTask): string {
  if (!isLoopTask(task)) return task.prompt
  if (task.loopMode === 'fixed') {
    return getLoopTaskPrompt(task)
  }

  return `# /loop wake-up

Loop ID: ${task.id}
This is a dynamic /loop iteration. Complete the loop if the work is done; otherwise choose the next wake-up delay between 1 and 60 minutes.

## Loop prompt

${getLoopTaskPrompt(task)}

${buildLoopExecutionInstructions(task)}`
}

export function getLoopTaskPrompt(task: SessionCronTask): string {
  if (task.promptSource === 'maintenance') {
    const maintenance = readLoopMaintenancePrompt()
    return maintenance.truncated
      ? `${maintenance.prompt}\n\n[Loop maintenance prompt was truncated to ${LOOP_MAINTENANCE_PROMPT_MAX_BYTES} bytes.]`
      : maintenance.prompt
  }
  return task.prompt
}

export function readLoopMaintenancePrompt(): LoopMaintenancePrompt {
  const candidates: Array<{
    source: LoopMaintenancePrompt['source']
    path: string
  }> = [
    { source: 'project', path: join(getProjectRoot(), '.claude', 'loop.md') },
    { source: 'user', path: join(homedir(), '.claude', 'loop.md') },
  ]

  for (const candidate of candidates) {
    const read = readPromptFile(candidate.path)
    if (!read) continue
    return {
      prompt: read.prompt,
      source: candidate.source,
      path: candidate.path,
      truncated: read.truncated,
    }
  }

  return {
    prompt: DEFAULT_MAINTENANCE_PROMPT,
    source: 'default',
    truncated: false,
  }
}

export function describeLoopTask(task: SessionCronTask): string {
  if (isDynamicLoopTask(task)) {
    if (typeof task.nextFireAt !== 'number') {
      return 'dynamic loop, waiting for Claude to choose the next delay'
    }
    return `dynamic loop, next wake-up ${new Date(task.nextFireAt).toLocaleString()}`
  }
  if (isFixedLoopTask(task)) {
    return `fixed loop, ${cronToHuman(task.cron)}`
  }
  return task.cron ? cronToHuman(task.cron) : 'scheduled task'
}

export function ensureSchedulerEnabledForLoop(): void {
  if (!getScheduledTasksEnabled()) {
    setScheduledTasksEnabled(true)
  }
}

function buildLoopExecutionInstructions(task: SessionCronTask): string {
  const slashInstruction =
    'If the loop prompt starts with "/", invoke it as a slash command with the Skill tool; otherwise act on it directly.'

  if (task.loopMode !== 'dynamic') {
    return slashInstruction
  }

  return `${slashInstruction}

## Dynamic loop control

At the end of this iteration, call ${LOOP_CONTROL_TOOL_NAME} for loop ID ${task.id}:
- Use action "continue" with delayMinutes from 1 to 60 and a concise reason when another wake-up is useful.
- Use action "complete" when no further wake-up is needed.

After the tool call, briefly state the chosen delay and reason, or that the loop is complete.`
}

function normalizeUnit(unit: string): 's' | 'm' | 'h' | 'd' {
  const lower = unit.toLowerCase()
  if (lower.startsWith('s')) return 's'
  if (lower.startsWith('m')) return 'm'
  if (lower.startsWith('h')) return 'h'
  return 'd'
}

function normalizeIntervalToken(token: string): string {
  const match = token.trim().toLowerCase().match(/^(\d+)([smhd])$/)
  if (!match) throw new Error(`Invalid loop interval '${token}'.`)
  return `${Number(match[1])}${match[2]}`
}

function nearestCleanMinuteInterval(minutes: number): number {
  const candidates = [
    1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60, 120, 180, 240, 360, 480, 720,
    1440,
  ]
  let best = candidates[0]!
  let bestDiff = Math.abs(minutes - best)
  for (const candidate of candidates.slice(1)) {
    const diff = Math.abs(minutes - candidate)
    if (diff < bestDiff || (diff === bestDiff && candidate > best)) {
      best = candidate
      bestDiff = diff
    }
  }
  return best
}

function minutesToInterval(minutes: number): string {
  if (minutes < 60) return `${minutes}m`
  if (minutes < 1440) return `${minutes / 60}h`
  return '1d'
}

function removeLoopTasksFromState(idSet?: ReadonlySet<string>): number {
  const tasks = getSessionCronTasks()
  const remaining = tasks.filter(task => {
    if (!isLoopTask(task)) return true
    return idSet ? !idSet.has(task.id) : false
  })
  const removed = tasks.length - remaining.length
  if (removed > 0) {
    replaceSessionCronTasks(remaining)
  }
  return removed
}

function readPromptFile(
  path: string,
): { prompt: string; truncated: boolean } | null {
  try {
    // eslint-disable-next-line custom-rules/no-sync-fs -- scheduler needs a fresh loop.md snapshot during its synchronous fire path.
    const buffer = readFileSync(path)
    const truncated = buffer.length > LOOP_MAINTENANCE_PROMPT_MAX_BYTES
    const prompt = buffer
      .subarray(0, LOOP_MAINTENANCE_PROMPT_MAX_BYTES)
      .toString('utf8')
      .trim()
    return { prompt: prompt || DEFAULT_MAINTENANCE_PROMPT, truncated }
  } catch {
    return null
  }
}

function getUserMessageText(
  message: Extract<Message, { type: 'user' }>,
): string {
  const content = message.message.content
  if (typeof content === 'string') return content
  return content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}
