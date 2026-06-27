import { resolve } from 'path'
import React from 'react'
import { AgentView } from '../components/AgentView.js'
import {
  attachAgentJob,
  createAgentJob,
  extractPromptFromArgs,
  formatAgentJobLine,
  getAgentDispatchDefaults,
  getAgentDaemonLogPath,
  listAgentJobs,
  openAgentJobSession,
  readAgentLogRaw,
  readAgentLog,
  readOptionValue,
  removeAgentJob,
  type RemoveAgentJobOptions,
  type AgentJobState,
  respawnAllStoppedAgentJobs,
  respawnAgentJob,
  stopAgentJob,
} from '../utils/agentView.js'
import { getBaseRenderOptions } from '../utils/renderOptions.js'

function exitWithCliError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`Error: ${message}\n`)
  process.exit(1)
}

function printAgentList(
  jobs: Awaited<ReturnType<typeof listAgentJobs>>,
): void {
  if (jobs.length === 0) {
    process.stdout.write('No background agents.\n')
    return
  }
  process.stdout.write('ID       Status           Project  Name\n')
  for (const job of jobs) {
    process.stdout.write(`${formatAgentJobLine(job)}\n`)
  }
}

function printAgentListJson(
  jobs: Awaited<ReturnType<typeof listAgentJobs>>,
): void {
  const safeJobs = jobs.map(job => ({
    id: job.id,
    sessionId: job.sessionId,
    cwd: job.cwd,
    rootCwd: job.rootCwd,
    prompt: job.prompt,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    model: job.model,
    effort: job.effort,
    permissionMode: job.permissionMode,
    agent: job.agent,
    name: job.name,
    lastPrompt: job.lastPrompt,
    lastResult: job.lastResult,
    exitCode: job.exitCode,
    pinned: job.pinned,
    attached: job.attached,
    workerPid: job.workerPid,
    daemonPid: job.daemonPid,
    transport: job.transport,
  }))
  process.stdout.write(`${JSON.stringify(safeJobs, null, 2)}\n`)
}

function readCwdArg(args: string[]): string | undefined {
  const cwd = readOptionValue(args, '--cwd')
  return cwd ? resolve(cwd) : undefined
}

function readNameArg(args: string[]): string | undefined {
  return readOptionValue(args, '--name')
}

function printAgentsHelp(): void {
  process.stdout.write(`Usage: claude agents [options]

Manage background agents.

Options:
  --cwd <path>             Filter background agents by working directory
  --model <model>          Default model for sessions dispatched from agent view
  --effort <level>         Default effort for dispatched sessions
  --permission-mode <mode> Default permission mode for dispatched sessions
  --settings <file-or-json> Load settings for agent view and dispatched sessions
  --add-dir <path>         Grant an additional directory (repeatable)
  --mcp-config <config>    Load MCP servers (repeatable)
  --plugin-dir <path>      Load a plugin directory (repeatable)
  --plugin-url <url>       Load a plugin ZIP URL (repeatable)
  --json                   Print background agents as JSON and exit
  -h, --help               Display help for command

Commands:
  list-definitions         List configured subagent definitions

Shortcuts:
  claude --bg <prompt>     Start a prompt as a background agent
  claude attach <id>       Attach to a background agent session
  claude logs <id>         Print a readable background agent log
  claude logs <id> --raw   Print raw terminal log
  claude stop <id>         Stop a background agent
  claude respawn <id>      Respawn a stopped agent session
  claude rm <id>           Remove a stopped agent record and its clean worktree
  claude rm <id> --discard-worktree
                           Remove even when the managed worktree has changes
`)
}

function normalizeArgs(argsOrId: string[] | string | undefined): string[] {
  if (Array.isArray(argsOrId)) return argsOrId
  return argsOrId ? [argsOrId] : []
}

function firstPositionalArg(argsOrId: string[] | string | undefined): string | undefined {
  return normalizeArgs(argsOrId).find(arg => !arg.startsWith('-'))
}

function hasArg(argsOrId: string[] | string | undefined, flag: string): boolean {
  return normalizeArgs(argsOrId).includes(flag)
}

function releaseTerminalForAgentViewRender(): void {
  const stdin = process.stdin as NodeJS.ReadStream & {
    isRaw?: boolean
    setRawMode?: (mode: boolean) => void
  }
  if (stdin.isTTY) {
    stdin.removeAllListeners('readable')
    stdin.removeAllListeners('data')
    stdin.removeAllListeners('keypress')
    if (stdin.isRaw && stdin.setRawMode) stdin.setRawMode(false)
    stdin.pause()
  }
  if (process.stdout.isTTY) {
    process.stdout.write('\x1b[?25h')
  }
}

async function renderAgentViewOnce(
  cwd: string | undefined,
  dispatchDefaults: ReturnType<typeof getAgentDispatchDefaults>,
): Promise<AgentJobState | null> {
  const { createRoot } = await import('../ink.js')
  let openedJob: AgentJobState | null = null
  const root = await createRoot(getBaseRenderOptions(false))
  root.render(
    React.createElement(AgentView, {
      cwd,
      dispatchDefaults,
      onOpenJob: job => {
        openedJob = job
      },
    }),
  )
  try {
    await root.waitUntilExit()
    return openedJob
  } finally {
    releaseTerminalForAgentViewRender()
  }
}

export async function agentsViewHandler(args: string[]): Promise<void> {
  try {
    if (args.includes('--help') || args.includes('-h')) {
      printAgentsHelp()
      return
    }
    if (args[0] === 'list-definitions') {
      const { agentsHandler } = await import('./handlers/agents.js')
      await agentsHandler()
      return
    }
    const cwd = readCwdArg(args)
    if (args.includes('--json')) {
      printAgentListJson(await listAgentJobs({ cwd }))
      return
    }
    if (!process.stdout.isTTY) {
      printAgentList(await listAgentJobs({ cwd }))
      return
    }
    const dispatchDefaults = getAgentDispatchDefaults(args)
    while (true) {
      const openedJob = await renderAgentViewOnce(cwd, dispatchDefaults)
      if (!openedJob) return
      const result = await openAgentJobSession(openedJob.id, {
        returnToAgentView: true,
      })
      if (!result.returnedToAgentView) {
        return
      }
    }
  } catch (error) {
    exitWithCliError(error)
  }
}

export async function psHandler(args: string[]): Promise<void> {
  try {
    printAgentList(await listAgentJobs({ cwd: readCwdArg(args) }))
  } catch (error) {
    exitWithCliError(error)
  }
}

export async function logsHandler(argsOrId: string[] | string | undefined): Promise<void> {
  try {
    const args = normalizeArgs(argsOrId)
    const id = firstPositionalArg(args)
    if (!id) throw new Error('Usage: claude logs <id>')
    if (id === 'daemon') {
      process.stdout.write(`${getAgentDaemonLogPath()}\n`)
      return
    }
    const reader = args.includes('--raw') ? readAgentLogRaw : readAgentLog
    const { text } = await reader(id, { bytes: 256 * 1024 })
    process.stdout.write(text || '(no logs yet)\n')
  } catch (error) {
    exitWithCliError(error)
  }
}

export async function attachHandler(argsOrId: string[] | string | undefined): Promise<void> {
  try {
    const id = firstPositionalArg(argsOrId)
    if (!id) throw new Error('Usage: claude attach <id>')
    await attachAgentJob(id)
  } catch (error) {
    exitWithCliError(error)
  }
}

async function stopLikeHandler(
  command: 'kill' | 'stop',
  argsOrId: string[] | string | undefined,
): Promise<void> {
  try {
    const id = firstPositionalArg(argsOrId)
    if (!id) throw new Error(`Usage: claude ${command} <id>`)
    const state = await stopAgentJob(id)
    process.stdout.write(`Stopped ${state.id}\n`)
  } catch (error) {
    exitWithCliError(error)
  }
}

export async function killHandler(argsOrId: string[] | string | undefined): Promise<void> {
  await stopLikeHandler('kill', argsOrId)
}

export async function stopHandler(argsOrId: string[] | string | undefined): Promise<void> {
  await stopLikeHandler('stop', argsOrId)
}

export async function respawnHandler(argsOrId: string[] | string | undefined): Promise<void> {
  try {
    const args = normalizeArgs(argsOrId)
    if (args.includes('--all')) {
      const states = await respawnAllStoppedAgentJobs()
      process.stdout.write(`Respawned ${states.length} background agents\n`)
      for (const state of states) {
        process.stdout.write(`  ${state.id} (${state.sessionId})\n`)
      }
      return
    }
    const id = firstPositionalArg(args)
    if (!id) throw new Error('Usage: claude respawn <id|--all>')
    const state = await respawnAgentJob(id)
    process.stdout.write(`Respawned ${state.id} (${state.sessionId})\n`)
  } catch (error) {
    exitWithCliError(error)
  }
}

export async function rmHandler(argsOrId: string[] | string | undefined): Promise<void> {
  try {
    const id = firstPositionalArg(argsOrId)
    if (!id) {
      throw new Error('Usage: claude rm <id> [--discard-worktree]')
    }
    const options: RemoveAgentJobOptions = {
      discardWorktreeChanges:
        hasArg(argsOrId, '--discard-worktree') || hasArg(argsOrId, '--force'),
    }
    const state = await removeAgentJob(id, options)
    process.stdout.write(`Removed ${state.id}\n`)
  } catch (error) {
    exitWithCliError(error)
  }
}

export async function handleBgFlag(args: string[]): Promise<void> {
  try {
    const prompt = extractPromptFromArgs(args)
    const defaults = getAgentDispatchDefaults(args)
    const state = await createAgentJob({
      cwd: defaults.cwd,
      rootCwd: defaults.rootCwd,
      prompt,
      args,
      name: readNameArg(args),
      model: defaults.model,
      effort: defaults.effort,
      permissionMode: defaults.permissionMode,
      agent: defaults.agent,
    })
    process.stdout.write(`Started background agent ${state.id}\n`)
    process.stdout.write(`Session: ${state.sessionId}\n`)
    process.stdout.write(`Log: ${state.logPath}\n`)
  } catch (error) {
    exitWithCliError(error)
  }
}
