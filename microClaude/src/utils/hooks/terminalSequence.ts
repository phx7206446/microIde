import { logForDebugging } from '../debug.js'
import type { SyncHookJSONOutput } from 'src/entrypoints/agentSdkTypes.js'

export const MAX_HOOK_TERMINAL_SEQUENCE_LENGTH = 16 * 1024
const MAX_PENDING_HOOK_TERMINAL_SEQUENCES = 16

type HookTerminalSequenceWriter = (sequence: string) => void
type PendingHookTerminalSequence = {
  sequence: string
  context: { hookName?: string; hookEvent?: string }
}

let hookTerminalSequenceWriter: HookTerminalSequenceWriter | null = null
let hasRegisteredHookTerminalSequenceWriter = false
let pendingHookTerminalSequences: PendingHookTerminalSequence[] = []

export function setHookTerminalSequenceWriter(
  writer: HookTerminalSequenceWriter | null,
): () => void {
  hookTerminalSequenceWriter = writer
  if (writer) {
    hasRegisteredHookTerminalSequenceWriter = true
    flushPendingHookTerminalSequences()
  }
  return () => {
    if (hookTerminalSequenceWriter === writer) {
      hookTerminalSequenceWriter = null
    }
  }
}

export function emitHookTerminalSequence(
  sequence: string,
  context: { hookName?: string; hookEvent?: string } = {},
): void {
  if (sequence.length === 0) {
    return
  }

  if (sequence.length > MAX_HOOK_TERMINAL_SEQUENCE_LENGTH) {
    logForDebugging(
      `Hooks: Ignoring terminalSequence from ${formatHookContext(context)} because it exceeds ${MAX_HOOK_TERMINAL_SEQUENCE_LENGTH} characters`,
      { level: 'error' },
    )
    return
  }

  if (sequence.includes('\0')) {
    logForDebugging(
      `Hooks: Ignoring terminalSequence from ${formatHookContext(context)} because it contains a NUL byte`,
      { level: 'error' },
    )
    return
  }

  if (!hookTerminalSequenceWriter) {
    if (!hasRegisteredHookTerminalSequenceWriter) {
      enqueuePendingHookTerminalSequence(sequence, context)
      return
    }

    logForDebugging(
      `Hooks: No interactive terminal writer available for terminalSequence from ${formatHookContext(context)}`,
    )
    return
  }

  writeHookTerminalSequence(sequence, context)
}

export function shouldEmitHookTerminalSequence(
  json: SyncHookJSONOutput,
  exitCode?: number,
): boolean {
  return (
    isAcceptedTerminalSequenceExitCode(exitCode) &&
    !isBlockingSyncHookOutput(json)
  )
}

export function stripHookTerminalSequenceFromJSONOutput(output: string): string {
  const trimmed = output.trim()
  if (!trimmed.startsWith('{') || !trimmed.includes('terminalSequence')) {
    return output
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !('terminalSequence' in parsed)
    ) {
      return output
    }

    delete (parsed as { terminalSequence?: unknown }).terminalSequence
    return Object.keys(parsed).length > 0 ? JSON.stringify(parsed) : ''
  } catch {
    return output
  }
}

function enqueuePendingHookTerminalSequence(
  sequence: string,
  context: { hookName?: string; hookEvent?: string },
): void {
  if (pendingHookTerminalSequences.length >= MAX_PENDING_HOOK_TERMINAL_SEQUENCES) {
    logForDebugging(
      `Hooks: Dropping terminalSequence from ${formatHookContext(context)} because the pre-REPL terminalSequence queue is full`,
      { level: 'error' },
    )
    return
  }

  pendingHookTerminalSequences.push({ sequence, context })
}

function flushPendingHookTerminalSequences(): void {
  if (!hookTerminalSequenceWriter || pendingHookTerminalSequences.length === 0) {
    return
  }

  const pending = pendingHookTerminalSequences
  pendingHookTerminalSequences = []
  for (const { sequence, context } of pending) {
    writeHookTerminalSequence(sequence, context)
  }
}

function writeHookTerminalSequence(
  sequence: string,
  context: { hookName?: string; hookEvent?: string },
): void {
  try {
    hookTerminalSequenceWriter?.(sequence)
  } catch (error) {
    logForDebugging(
      `Hooks: Failed to write terminalSequence from ${formatHookContext(context)}: ${error}`,
      { level: 'error' },
    )
  }
}

function isAcceptedTerminalSequenceExitCode(exitCode?: number): boolean {
  return (
    exitCode === undefined ||
    exitCode === 0 ||
    (exitCode >= 200 && exitCode < 300)
  )
}

function isBlockingSyncHookOutput(json: SyncHookJSONOutput): boolean {
  if (json.continue === false || json.decision === 'block') {
    return true
  }

  const specific = json.hookSpecificOutput
  if (!specific) {
    return false
  }

  switch (specific.hookEventName) {
    case 'PreToolUse':
      return specific.permissionDecision === 'deny'
    case 'PermissionRequest':
      return specific.decision.behavior === 'deny'
    case 'Elicitation':
    case 'ElicitationResult':
      return specific.action === 'decline'
    default:
      return false
  }
}

function formatHookContext({
  hookName,
  hookEvent,
}: {
  hookName?: string
  hookEvent?: string
}): string {
  return hookName ?? hookEvent ?? 'hook'
}
