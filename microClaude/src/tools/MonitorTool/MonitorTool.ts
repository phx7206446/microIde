import { z } from 'zod/v4'
import {
  OUTPUT_FILE_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
  TOOL_USE_ID_TAG,
} from '../../constants/xml.js'
import { startMcpResourceMonitor } from '../../services/mcp/resourceMonitor.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { spawnShellTask } from '../../tasks/LocalShellTask/LocalShellTask.js'
import type { AgentId } from '../../types/ids.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { enqueuePendingNotification } from '../../utils/messageQueueManager.js'
import { getPlatform } from '../../utils/platform.js'
import { semanticBoolean } from '../../utils/semanticBoolean.js'
import { semanticNumber } from '../../utils/semanticNumber.js'
import { exec } from '../../utils/Shell.js'
import type { ShellType } from '../../utils/shell/shellProvider.js'
import { escapeXml } from '../../utils/xml.js'
import { shouldUseSandbox } from '../BashTool/shouldUseSandbox.js'

const MONITOR_TOOL_NAME = 'monitor'
const DEFAULT_MONITOR_TIMEOUT_MS = 24 * 60 * 60 * 1000
const MAX_MONITOR_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000
const MAX_MONITOR_SUMMARY_LENGTH = 400
const MAX_MONITOR_DESCRIPTION_LENGTH = 120

const inputSchema = lazySchema(() =>
  z.strictObject({
    command: z
      .string()
      .optional()
      .describe(
        'A background command to monitor. Each stdout line becomes a notification.',
      ),
    description: z
      .string()
      .optional()
      .describe('Optional short label for the monitor task.'),
    shell: z
      .enum(['bash', 'powershell'])
      .optional()
      .describe(
        'Optional shell to use for command monitors. Defaults to PowerShell on Windows and bash elsewhere.',
      ),
    timeout: semanticNumber(z.number().optional())
      .describe(
        `Optional timeout in milliseconds for command monitors (default ${DEFAULT_MONITOR_TIMEOUT_MS}, max ${MAX_MONITOR_TIMEOUT_MS}).`,
      ),
    dangerouslyDisableSandbox: semanticBoolean(z.boolean().optional())
      .describe(
        'Set to true to disable sandboxing for command monitors when policy allows it.',
      ),
    serverName: z
      .string()
      .optional()
      .describe('The MCP server name for a resource monitor.'),
    server_name: z
      .string()
      .optional()
      .describe('Snake_case alias for serverName.'),
    resourceUri: z
      .string()
      .optional()
      .describe('The MCP resource URI to monitor for updates.'),
    resource_uri: z
      .string()
      .optional()
      .describe('Snake_case alias for resourceUri.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    status: z.literal('async_launched'),
    taskId: z.string().describe('The monitor task ID'),
    outputFile: z.string().describe('Path to the monitor output file'),
    monitorKind: z
      .enum(['command', 'mcp'])
      .describe('Whether this monitor is a command monitor or MCP resource monitor'),
    command: z
      .string()
      .optional()
      .describe('The command being monitored, for command monitors'),
    shell: z
      .enum(['bash', 'powershell'])
      .optional()
      .describe('The shell used to run a command monitor'),
    serverName: z
      .string()
      .optional()
      .describe('The MCP server name for a resource monitor'),
    resourceUri: z
      .string()
      .optional()
      .describe('The MCP resource URI for a resource monitor'),
    description: z.string().optional().describe('Monitor label'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

type Output = z.infer<OutputSchema>

type CommandMonitorTarget = {
  mode: 'command'
  command: string
  description: string
  explicitDescription?: string
}

type McpMonitorTarget = {
  mode: 'mcp'
  serverName: string
  resourceUri: string
  description: string
  explicitDescription?: string
}

type InvalidMonitorTarget = {
  mode: 'invalid'
  message: string
}

type MonitorTarget =
  | CommandMonitorTarget
  | McpMonitorTarget
  | InvalidMonitorTarget

function getDefaultShell(): ShellType {
  return getPlatform() === 'windows' ? 'powershell' : 'bash'
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed && trimmed !== '' ? trimmed : undefined
}

function normalizeCommand(command: string | undefined): string {
  return command?.trim() ?? ''
}

function getExplicitDescription(description?: string): string | undefined {
  return normalizeOptionalString(description)
}

function normalizeCommandDescription(
  command: string,
  description?: string,
): string {
  return getExplicitDescription(description) ?? command
}

function normalizeMcpDescription(
  serverName: string,
  resourceUri: string,
  description?: string,
): string {
  return getExplicitDescription(description) ?? `${serverName}: ${resourceUri}`
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text
  }
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`
}

function buildLineSummary(description: string, line: string): string {
  const compactDescription = truncateText(
    description,
    MAX_MONITOR_DESCRIPTION_LENGTH,
  )
  const compactLine = truncateText(line, MAX_MONITOR_SUMMARY_LENGTH)
  return `Monitor "${compactDescription}": ${compactLine}`
}

function formatMonitorStartFailure(params: {
  description: string
  code: number
  stdout: string
  stderr: string
  interrupted: boolean
}): string {
  const stderr = params.stderr.trim()
  if (stderr !== '') {
    return stderr
  }

  const stdout = params.stdout.trim()
  if (params.interrupted) {
    return `Monitor "${params.description}" was interrupted before it could be backgrounded`
  }

  if (params.code === 0) {
    const baseMessage =
      `Monitor "${params.description}" exited before it could be backgrounded. ` +
      'Monitor is for streaming events from a long-running process. ' +
      'For one-shot background work, use Bash or PowerShell with run_in_background instead.'

    if (stdout === '') {
      return baseMessage
    }

    return `${baseMessage}\n\nLast stdout:\n${stdout}`
  }

  return `Monitor "${params.description}" failed before it could be backgrounded (exit ${params.code})`
}

function normalizeAliasedField(params: {
  fieldName: string
  camelCase?: string
  snakeCase?: string
}): { value?: string; error?: string } {
  const camelCase = normalizeOptionalString(params.camelCase)
  const snakeCase = normalizeOptionalString(params.snakeCase)

  if (camelCase && snakeCase && camelCase !== snakeCase) {
    return {
      error: `${params.fieldName} cannot contain conflicting camelCase and snake_case values`,
    }
  }

  return { value: camelCase ?? snakeCase }
}

function getMonitorTarget(input: {
  command?: string
  description?: string
  serverName?: string
  server_name?: string
  resourceUri?: string
  resource_uri?: string
}): MonitorTarget {
  const command = normalizeCommand(input.command)
  const serverNameField = normalizeAliasedField({
    fieldName: 'serverName',
    camelCase: input.serverName,
    snakeCase: input.server_name,
  })
  if (serverNameField.error) {
    return { mode: 'invalid', message: serverNameField.error }
  }

  const resourceUriField = normalizeAliasedField({
    fieldName: 'resourceUri',
    camelCase: input.resourceUri,
    snakeCase: input.resource_uri,
  })
  if (resourceUriField.error) {
    return { mode: 'invalid', message: resourceUriField.error }
  }

  const serverName = serverNameField.value
  const resourceUri = resourceUriField.value
  const hasCommand = command !== ''
  const hasAnyMcpField = serverName !== undefined || resourceUri !== undefined

  if (hasCommand && hasAnyMcpField) {
    return {
      mode: 'invalid',
      message:
        'Use either command monitoring or MCP resource monitoring, not both in the same monitor call',
    }
  }

  if (!hasCommand && !hasAnyMcpField) {
    return {
      mode: 'invalid',
      message:
        'Monitor requires either a command or both serverName and resourceUri',
    }
  }

  if (hasCommand) {
    return {
      mode: 'command',
      command,
      description: normalizeCommandDescription(command, input.description),
      explicitDescription: getExplicitDescription(input.description),
    }
  }

  if (!serverName || !resourceUri) {
    return {
      mode: 'invalid',
      message:
        'MCP resource monitors require both serverName and resourceUri',
    }
  }

  return {
    mode: 'mcp',
    serverName,
    resourceUri,
    description: normalizeMcpDescription(
      serverName,
      resourceUri,
      input.description,
    ),
    explicitDescription: getExplicitDescription(input.description),
  }
}

type MonitorNotificationTarget = {
  taskId: string
  outputFile: string
}

function createMonitorOutputNotifier(params: {
  description: string
  toolUseId?: string
  agentId?: AgentId
}) {
  let buffer = ''
  let pendingLines: string[] = []
  let target: MonitorNotificationTarget | null = null

  const emitLine = (line: string): void => {
    const trimmedLine = line.trim()
    if (trimmedLine === '' || target === null) {
      return
    }

    const toolUseIdLine = params.toolUseId
      ? `\n<${TOOL_USE_ID_TAG}>${params.toolUseId}</${TOOL_USE_ID_TAG}>`
      : ''
    const message = `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${target.taskId}</${TASK_ID_TAG}>${toolUseIdLine}
<${OUTPUT_FILE_TAG}>${target.outputFile}</${OUTPUT_FILE_TAG}>
<${SUMMARY_TAG}>${escapeXml(
      buildLineSummary(params.description, trimmedLine),
    )}</${SUMMARY_TAG}>
</${TASK_NOTIFICATION_TAG}>`

    enqueuePendingNotification({
      value: message,
      mode: 'task-notification',
      priority: 'next',
      agentId: params.agentId,
    })
  }

  const queueOrEmitLine = (line: string): void => {
    const trimmedLine = line.trim()
    if (trimmedLine === '') {
      return
    }
    if (target === null) {
      pendingLines.push(trimmedLine)
      return
    }
    emitLine(trimmedLine)
  }

  return {
    pushChunk(chunk: string): void {
      buffer += chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex)
        buffer = buffer.slice(newlineIndex + 1)
        queueOrEmitLine(line)
        newlineIndex = buffer.indexOf('\n')
      }
    },
    activate(nextTarget: MonitorNotificationTarget): void {
      target = nextTarget
      if (pendingLines.length === 0) {
        return
      }
      for (const line of pendingLines) {
        emitLine(line)
      }
      pendingLines = []
    },
    flushRemainder(): void {
      if (buffer.trim() !== '') {
        queueOrEmitLine(buffer)
      }
      buffer = ''
    },
  }
}

function getShouldUseSandbox(
  shell: ShellType,
  input: { command: string; dangerouslyDisableSandbox?: boolean },
): boolean {
  if (shell === 'powershell' && getPlatform() === 'windows') {
    return false
  }
  return shouldUseSandbox(input)
}

const PROMPT = `Stream updates from either a background command or an MCP resource.

Use this tool when you want an ongoing monitor whose updates should come back as task notifications.

Command monitors:
- Set \`command\` to the command to run.
- Each stdout line becomes one monitor event.
- Optionally set \`description\`, \`shell\`, \`timeout\`, and \`dangerouslyDisableSandbox\`.

MCP resource monitors:
- Set \`serverName\` and \`resourceUri\` (or the snake_case aliases).
- The monitor subscribes to \`notifications/resources/updated\` and re-reads the resource on each update.
- Use ListMcpResourcesTool first if you need to discover available resource URIs.

Important:
- Use either command monitoring or MCP resource monitoring in a single call, never both.
- stderr from command monitors is still captured in the task output file, but only stdout lines generate notifications.
- The command is backgrounded automatically. Do not add shell background syntax like \`&\`.
- For one-shot background work where you only need the final result, use Bash or PowerShell with \`run_in_background\` instead.`

export const MonitorTool = buildTool({
  name: MONITOR_TOOL_NAME,
  searchHint: 'stream background command output or MCP resource updates',
  maxResultSizeChars: 10_000,
  strict: true,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  async description(input) {
    const target = getMonitorTarget(input)
    if (target.mode === 'command' || target.mode === 'mcp') {
      return target.description
    }
    return 'Start a monitor'
  },
  async prompt() {
    return PROMPT
  },
  isEnabled() {
    return !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS)
  },
  toAutoClassifierInput(input) {
    const target = getMonitorTarget(input)
    if (target.mode === 'command') {
      return target.command
    }
    if (target.mode === 'mcp') {
      return `${target.serverName} ${target.resourceUri}`
    }
    return ''
  },
  userFacingName() {
    return 'Monitor'
  },
  getToolUseSummary(input) {
    const target = getMonitorTarget(input ?? {})
    if (target.mode === 'invalid') {
      return null
    }
    return truncateText(target.description, 120)
  },
  getActivityDescription(input) {
    const target = getMonitorTarget(input ?? {})
    if (target.mode === 'invalid') {
      return 'Starting monitor'
    }
    return `Starting monitor ${truncateText(target.description, 120)}`
  },
  renderToolUseMessage() {
    return null
  },
  async validateInput(input, context) {
    if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS)) {
      return {
        result: false,
        message: 'MonitorTool is unavailable when background tasks are disabled',
        errorCode: 1,
      }
    }

    const target = getMonitorTarget(input)
    if (target.mode === 'invalid') {
      return {
        result: false,
        message: target.message,
        errorCode: 2,
      }
    }

    if (target.mode === 'command') {
      if (
        input.timeout !== undefined &&
        (input.timeout <= 0 || input.timeout > MAX_MONITOR_TIMEOUT_MS)
      ) {
        return {
          result: false,
          message: `Monitor timeout must be between 1 and ${MAX_MONITOR_TIMEOUT_MS} milliseconds`,
          errorCode: 3,
        }
      }

      return { result: true }
    }

    if (
      input.shell !== undefined ||
      input.timeout !== undefined ||
      input.dangerouslyDisableSandbox !== undefined
    ) {
      return {
        result: false,
        message:
          'shell, timeout, and dangerouslyDisableSandbox are only supported for command monitors',
        errorCode: 4,
      }
    }

    const client = context.options.mcpClients.find(
      candidate => candidate.name === target.serverName,
    )
    if (!client) {
      return {
        result: false,
        message: `MCP server "${target.serverName}" not found`,
        errorCode: 5,
      }
    }

    if (client.type !== 'connected') {
      return {
        result: false,
        message: `MCP server "${target.serverName}" is not connected`,
        errorCode: 6,
      }
    }

    if (!client.capabilities?.resources) {
      return {
        result: false,
        message: `MCP server "${target.serverName}" does not support resources`,
        errorCode: 7,
      }
    }

    if (client.capabilities.resources.subscribe !== true) {
      return {
        result: false,
        message: `MCP server "${target.serverName}" does not support resource subscriptions`,
        errorCode: 8,
      }
    }

    return { result: true }
  },
  async checkPermissions(input) {
    const target = getMonitorTarget(input)
    if (target.mode === 'invalid') {
      return {
        behavior: 'deny',
        message: target.message,
        decisionReason: {
          type: 'other',
          reason: target.message,
        },
      }
    }

    return {
      behavior: 'ask',
      message: `Start monitor: ${target.description}`,
      updatedInput:
        target.mode === 'command'
          ? {
              ...input,
              command: target.command,
            }
          : {
              ...(target.explicitDescription
                ? { description: target.explicitDescription }
                : {}),
              serverName: target.serverName,
              resourceUri: target.resourceUri,
            },
    }
  },
  async call(input, context): Promise<{ data: Output }> {
    const target = getMonitorTarget(input)
    if (target.mode === 'invalid') {
      throw new Error(target.message)
    }

    const rootSetAppState = context.setAppStateForTasks ?? context.setAppState

    if (target.mode === 'command') {
      const shell = input.shell ?? getDefaultShell()
      const notifier = createMonitorOutputNotifier({
        description: target.description,
        toolUseId: context.toolUseId,
        agentId: context.agentId,
      })

      const shellCommand = await exec(
        target.command,
        context.abortController.signal,
        shell,
        {
          timeout: input.timeout ?? DEFAULT_MONITOR_TIMEOUT_MS,
          onStdout(chunk) {
            notifier.pushChunk(chunk)
          },
          shouldUseSandbox: getShouldUseSandbox(shell, {
            command: target.command,
            dangerouslyDisableSandbox: input.dangerouslyDisableSandbox,
          }),
        },
      )

      if (shellCommand.status !== 'running') {
        const result = await shellCommand.result
        shellCommand.cleanup()
        throw new Error(
          formatMonitorStartFailure({
            description: target.description,
            code: result.code,
            stdout: result.stdout,
            stderr: result.stderr,
            interrupted: result.interrupted,
          }),
        )
      }

      void shellCommand.result.then(() => {
        notifier.flushRemainder()
      })

      let taskId: string
      try {
        const handle = await spawnShellTask(
          {
            command: target.command,
            description: target.description,
            shellCommand,
            toolUseId: context.toolUseId,
            agentId: context.agentId,
            kind: 'monitor',
          },
          {
            abortController: context.abortController,
            getAppState: context.getAppState,
            setAppState: rootSetAppState,
          },
        )
        taskId = handle.taskId
      } catch (error) {
        shellCommand.kill()
        shellCommand.cleanup()
        throw error
      }

      notifier.activate({
        taskId,
        outputFile: shellCommand.taskOutput.path,
      })

      return {
        data: {
          status: 'async_launched',
          taskId,
          outputFile: shellCommand.taskOutput.path,
          monitorKind: 'command',
          command: target.command,
          shell,
          description: target.description,
        },
      }
    }

    const client = context.options.mcpClients.find(
      candidate => candidate.name === target.serverName,
    )
    if (!client || client.type !== 'connected') {
      throw new Error(`MCP server "${target.serverName}" is not connected`)
    }

    const handle = await startMcpResourceMonitor({
      client,
      description: target.description,
      serverName: target.serverName,
      resourceUri: target.resourceUri,
      setAppState: rootSetAppState,
      toolUseId: context.toolUseId,
      agentId: context.agentId,
    })

    return {
      data: {
        status: 'async_launched',
        taskId: handle.taskId,
        outputFile: handle.outputFile,
        monitorKind: 'mcp',
        serverName: target.serverName,
        resourceUri: target.resourceUri,
        description: target.description,
      },
    }
  },
  mapToolResultToToolResultBlockParam(data, toolUseID) {
    const label =
      data.description ??
      (data.monitorKind === 'command'
        ? data.command
        : `${data.serverName}: ${data.resourceUri}`)

    const body =
      data.monitorKind === 'command'
        ? `Started monitor "${label}" in the background as task ${data.taskId}. Each stdout line will arrive as a notification. Output is being written to ${data.outputFile}. Use Read to inspect it or TaskStop to stop the monitor.`
        : `Started MCP resource monitor "${label}" in the background as task ${data.taskId}. Resource updates will arrive as notifications. Output is being written to ${data.outputFile}. Use Read to inspect it or TaskStop to stop the monitor.`

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: body,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
