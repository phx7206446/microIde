import type { AppState } from '../../state/AppState.js'
import { abortSpeculation } from '../../services/PromptSuggestion/speculation.js'
import {
  OUTPUT_FILE_TAG,
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
  TOOL_USE_ID_TAG,
} from '../../constants/xml.js'
import {
  createTaskStateBase,
  type SetAppState,
  type Task,
  type TaskHandle,
  type TaskStateBase,
  generateTaskId,
} from '../../Task.js'
import type { AgentId } from '../../types/ids.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { dequeueAllMatching } from '../../utils/messageQueueManager.js'
import {
  evictTaskOutput,
  getTaskOutputPath,
} from '../../utils/task/diskOutput.js'
import { registerTask, updateTaskState } from '../../utils/task/framework.js'
import { enqueuePendingNotification } from '../../utils/messageQueueManager.js'
import { emitTaskTerminatedSdk } from '../../utils/sdkEventQueue.js'
import { escapeXml } from '../../utils/xml.js'

type SetAppStateFn = (updater: (prev: AppState) => AppState) => void

export type MonitorMcpTaskState = TaskStateBase & {
  type: 'monitor_mcp'
  command: string
  serverName?: string
  resourceUri?: string
  agentId?: AgentId
  stop?: () => void | Promise<void>
}

export type RegisterMonitorMcpTaskInput = {
  description: string
  command: string
  toolUseId?: string
  serverName?: string
  resourceUri?: string
  agentId?: AgentId
  stop?: () => void | Promise<void>
}

export function registerMonitorMcpTask(
  input: RegisterMonitorMcpTaskInput,
  setAppState: SetAppState,
): TaskHandle {
  const taskId = generateTaskId('monitor_mcp')
  const taskState: MonitorMcpTaskState = {
    ...createTaskStateBase(
      taskId,
      'monitor_mcp',
      input.description,
      input.toolUseId,
    ),
    type: 'monitor_mcp',
    status: 'running',
    command: input.command,
    serverName: input.serverName,
    resourceUri: input.resourceUri,
    agentId: input.agentId,
    stop: input.stop,
  }

  registerTask(taskState, setAppState)

  return {
    taskId,
    cleanup: () => {
      void evictTaskOutput(taskId)
    },
  }
}

function buildMonitorMcpSummary(
  description: string,
  status: 'completed' | 'failed' | 'killed',
  reason?: string,
): string {
  switch (status) {
    case 'completed':
      return `Monitor "${description}" stream ended`
    case 'failed':
      return `Monitor "${description}" failed${reason ? `: ${reason}` : ''}`
    case 'killed':
      return `Monitor "${description}" stopped`
  }
}

function enqueueMonitorMcpNotification(params: {
  taskId: string
  description: string
  status: 'completed' | 'failed' | 'killed'
  setAppState: SetAppState
  toolUseId?: string
  agentId?: AgentId
  reason?: string
}): void {
  let shouldEnqueue = false

  updateTaskState<MonitorMcpTaskState>(
    params.taskId,
    params.setAppState,
    task => {
      if (task.type !== 'monitor_mcp' || task.notified) {
        return task
      }

      shouldEnqueue = true
      return {
        ...task,
        notified: true,
      }
    },
  )

  if (!shouldEnqueue) {
    return
  }

  abortSpeculation(params.setAppState)

  const toolUseIdLine = params.toolUseId
    ? `\n<${TOOL_USE_ID_TAG}>${params.toolUseId}</${TOOL_USE_ID_TAG}>`
    : ''
  const message = `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${params.taskId}</${TASK_ID_TAG}>${toolUseIdLine}
<${OUTPUT_FILE_TAG}>${getTaskOutputPath(params.taskId)}</${OUTPUT_FILE_TAG}>
<${STATUS_TAG}>${params.status}</${STATUS_TAG}>
<${SUMMARY_TAG}>${escapeXml(
    buildMonitorMcpSummary(params.description, params.status, params.reason),
  )}</${SUMMARY_TAG}>
</${TASK_NOTIFICATION_TAG}>`

  enqueuePendingNotification({
    value: message,
    mode: 'task-notification',
    priority: 'next',
    agentId: params.agentId,
  })
}

export function completeMonitorMcp(
  taskId: string,
  setAppState: SetAppState,
  options: {
    status?: 'completed' | 'failed'
    reason?: string
  } = {},
): void {
  const status = options.status ?? 'completed'
  let shouldEnqueue = false
  let description = ''
  let toolUseId: string | undefined
  let agentId: AgentId | undefined

  updateTaskState<MonitorMcpTaskState>(taskId, setAppState, task => {
    if (task.type !== 'monitor_mcp' || task.status !== 'running') {
      return task
    }

    shouldEnqueue = !task.notified
    description = task.description
    toolUseId = task.toolUseId
    agentId = task.agentId

    return {
      ...task,
      status,
      stop: undefined,
      endTime: Date.now(),
    }
  })

  if (shouldEnqueue) {
    enqueueMonitorMcpNotification({
      taskId,
      description,
      status,
      setAppState,
      toolUseId,
      agentId,
      reason: options.reason,
    })
  }

  void evictTaskOutput(taskId)
}

export function killMonitorMcp(
  taskId: string,
  setAppState: SetAppStateFn,
): void {
  let stop: (() => void | Promise<void>) | undefined
  let killed = false
  let shouldEnqueue = false
  let toolUseId: string | undefined
  let description: string | undefined
  let agentId: AgentId | undefined

  updateTaskState<MonitorMcpTaskState>(taskId, setAppState, task => {
    if (task.type !== 'monitor_mcp' || task.status !== 'running') {
      return task
    }

    killed = true
    shouldEnqueue = !task.notified
    stop = task.stop
    toolUseId = task.toolUseId
    description = task.description
    agentId = task.agentId

    return {
      ...task,
      status: 'killed',
      stop: undefined,
      endTime: Date.now(),
    }
  })

  if (killed) {
    if (shouldEnqueue && description !== undefined) {
      enqueueMonitorMcpNotification({
        taskId,
        description,
        status: 'killed',
        setAppState,
        toolUseId,
        agentId,
      })
    }

    try {
      logForDebugging(`MonitorMcpTask ${taskId} kill requested`)
      void stop?.()
    } catch (error) {
      logError(error)
    }

    emitTaskTerminatedSdk(taskId, 'stopped', {
      toolUseId,
      summary: description,
    })
  }

  void evictTaskOutput(taskId)
}

export function killMonitorMcpTasksForAgent(
  agentId: AgentId,
  getAppState: () => AppState,
  setAppState: SetAppStateFn,
): void {
  const tasks = getAppState().tasks ?? {}
  for (const [taskId, task] of Object.entries(tasks)) {
    if (
      task.type === 'monitor_mcp' &&
      task.agentId === agentId &&
      task.status === 'running'
    ) {
      logForDebugging(
        `killMonitorMcpTasksForAgent: killing orphaned monitor task ${taskId} (agent ${agentId} exiting)`,
      )
      killMonitorMcp(taskId, setAppState)
    }
  }
  dequeueAllMatching(cmd => cmd.agentId === agentId)
}

export const MonitorMcpTask: Task = {
  name: 'MonitorMcpTask',
  type: 'monitor_mcp',
  async kill(taskId, setAppState) {
    killMonitorMcp(taskId, setAppState)
  },
}
