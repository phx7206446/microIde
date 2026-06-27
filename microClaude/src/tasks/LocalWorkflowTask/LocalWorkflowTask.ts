import { abortSpeculation } from '../../services/PromptSuggestion/speculation.js'
import type { AppState } from '../../state/AppState.js'
import type { SetAppState, Task, TaskStateBase } from '../../Task.js'
import { createTaskStateBase } from '../../Task.js'
import type { SdkWorkflowProgress } from '../../types/tools.js'
import { createAbortController } from '../../utils/abortController.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { enqueuePendingNotification } from '../../utils/messageQueueManager.js'
import {
  emitTaskTerminatedSdk,
  emitTaskUpdatedSdk,
} from '../../utils/sdkEventQueue.js'
import { evictTaskOutput, getTaskOutputPath } from '../../utils/task/diskOutput.js'
import { registerTask, updateTaskState } from '../../utils/task/framework.js'
import {
  OUTPUT_FILE_TAG,
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
  TOOL_USE_ID_TAG,
  WORKTREE_BRANCH_TAG,
  WORKTREE_PATH_TAG,
  WORKTREE_TAG,
} from '../../constants/xml.js'
import type { AgentProgress } from '../LocalAgentTask/LocalAgentTask.js'

export type WorkflowRunResult = {
  runId: string
  content: string
  totalDurationMs: number
  totalTokens: number
  totalToolUseCount: number
  scriptPath?: string
}

export type WorkflowPauseController = {
  pause(): void
  resume(): void
  isPaused(): boolean
}

export type LocalWorkflowTaskState = TaskStateBase & {
  type: 'local_workflow'
  runId: string
  summary?: string
  workflowName?: string
  scriptPath?: string
  phaseTitles: string[]
  agentCount: number
  isBackgrounded: boolean
  isPaused: boolean
  pauseStartedAt?: number
  pauseController?: WorkflowPauseController
  restartWorkflowHandler?: () => void
  abortController?: AbortController
  unregisterCleanup?: () => void
  agentControllers: Map<string, AbortController>
  restartAgentHandlers: Map<string, () => void>
  skipAgentHandlers: Map<string, () => void>
  workflowProgress: SdkWorkflowProgress[]
  progress?: AgentProgress
  error?: string
  result?: WorkflowRunResult
}

function createInitialWorkflowProgress(
  workflowName: string | undefined,
  description: string,
  summary: string | undefined,
  agentCount: number,
  phaseTitles: readonly string[],
): SdkWorkflowProgress[] {
  if (agentCount === 0 && phaseTitles.length > 0) {
    return phaseTitles.map((title, index) => ({
      type: 'workflow_phase',
      index: index + 1,
      title,
      state: index === 0 ? 'start' : undefined,
      detail: index === 0 ? (summary ?? description) : undefined,
    }))
  }

  return Array.from({ length: agentCount }, (_, index) => ({
    type: 'workflow_agent',
    index: index + 1,
    phaseIndex: 1,
    state: 'start',
    label:
      agentCount === 1
        ? (workflowName ?? description)
        : `${workflowName ?? 'Workflow'} ${index + 1}`,
    promptPreview: summary ?? description,
  }))
}

function withUpdatedWorkflowProgress(
  workflowProgress: readonly SdkWorkflowProgress[],
  agentId: string,
  status: string,
  message?: string,
): SdkWorkflowProgress[] {
  const hasExactAgentMatch = workflowProgress.some(
    item =>
      item.type === 'workflow_agent' &&
      typeof item.agentId === 'string' &&
      item.agentId === agentId,
  )

  return workflowProgress.map((item, index) => {
    if (item.type !== 'workflow_agent') {
      return item
    }

    const itemAgentId =
      typeof item.agentId === 'string' ? item.agentId : undefined
    const matchesAgent = hasExactAgentMatch
      ? itemAgentId === agentId
      : index === 0
    if (!matchesAgent) {
      return item
    }

    return {
      ...item,
      agentId,
      state: status === 'running' ? 'start' : status === 'failed' ? 'error' : status === 'completed' ? 'done' : 'queued',
      ...(message
        ? status === 'failed'
          ? { error: message }
          : { resultPreview: message }
        : {}),
    }
  })
}

function markWorkflowTaskNotified(
  taskId: string,
  setAppState: SetAppState,
): boolean {
  let shouldEnqueue = false
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => {
    if (task.notified) {
      return task
    }

    shouldEnqueue = true
    return {
      ...task,
      notified: true,
    }
  })

  return shouldEnqueue
}

export function isLocalWorkflowTask(
  task: unknown,
): task is LocalWorkflowTaskState {
  return (
    typeof task === 'object' &&
    task !== null &&
    'type' in task &&
    task.type === 'local_workflow'
  )
}

export function registerWorkflowTask({
  taskId,
  runId,
  description,
  workflowName,
  scriptPath,
  pauseController,
  phaseTitles,
  summary,
  agentCount,
  setAppState,
  toolUseId,
}: {
  taskId: string
  runId: string
  description: string
  workflowName?: string
  scriptPath?: string
  pauseController?: WorkflowPauseController
  phaseTitles?: readonly string[]
  summary?: string
  agentCount: number
  setAppState: SetAppState
  toolUseId?: string
}): LocalWorkflowTaskState {
  const abortController = createAbortController()
  const taskState: LocalWorkflowTaskState = {
    ...createTaskStateBase(taskId, 'local_workflow', description, toolUseId),
    type: 'local_workflow',
    runId,
    status: 'running',
    workflowName,
    scriptPath,
    phaseTitles: [...(phaseTitles ?? [])],
    summary,
    agentCount,
    isBackgrounded: true,
    isPaused: false,
    pauseController,
    abortController,
    agentControllers: new Map(),
    restartAgentHandlers: new Map(),
    skipAgentHandlers: new Map(),
    workflowProgress: createInitialWorkflowProgress(
      workflowName,
      description,
      summary,
      agentCount,
      phaseTitles ?? [],
    ),
  }

  const unregisterCleanup = registerCleanup(async () => {
    killWorkflowTask(taskId, setAppState)
  })
  taskState.unregisterCleanup = unregisterCleanup

  registerTask(taskState, setAppState)
  return taskState
}

export function setWorkflowAgentController(
  taskId: string,
  agentId: string,
  abortController: AbortController,
  setAppState: SetAppState,
): void {
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => {
    task.agentControllers.set(agentId, abortController)
    return {
      ...task,
      workflowProgress: withUpdatedWorkflowProgress(
        task.workflowProgress,
        agentId,
        'running',
      ),
    }
  })
}

export function clearWorkflowAgentController(
  taskId: string,
  agentId: string,
  setAppState: SetAppState,
): void {
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => {
    task.agentControllers.delete(agentId)
    task.restartAgentHandlers.delete(agentId)
    task.skipAgentHandlers.delete(agentId)
    return { ...task }
  })
}

export function setWorkflowAgentRestartHandler(
  taskId: string,
  agentId: string,
  restartHandler: () => void,
  setAppState: SetAppState,
): void {
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => {
    task.restartAgentHandlers.set(agentId, restartHandler)
    return { ...task }
  })
}

export function setWorkflowAgentSkipHandler(
  taskId: string,
  agentId: string,
  skipHandler: () => void,
  setAppState: SetAppState,
): void {
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => {
    task.skipAgentHandlers.set(agentId, skipHandler)
    return { ...task }
  })
}

export function setWorkflowRestartHandler(
  taskId: string,
  restartHandler: () => void,
  setAppState: SetAppState,
): void {
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => ({
    ...task,
    restartWorkflowHandler: restartHandler,
  }))
}

function finishPauseAccounting(
  task: LocalWorkflowTaskState,
  now: number,
): Pick<
  LocalWorkflowTaskState,
  'isPaused' | 'pauseStartedAt' | 'pauseController' | 'totalPausedMs'
> {
  const activePauseMs =
    task.isPaused && task.pauseStartedAt
      ? Math.max(0, now - task.pauseStartedAt)
      : 0

  return {
    isPaused: false,
    pauseStartedAt: undefined,
    pauseController: undefined,
    totalPausedMs: (task.totalPausedMs ?? 0) + activePauseMs,
  }
}

export function updateWorkflowTaskProgress(
  taskId: string,
  params: {
    progress: AgentProgress
    workflowProgress: SdkWorkflowProgress[]
    summary?: string
    agentCount?: number
  },
  setAppState: SetAppState,
): void {
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') {
      return task
    }

    return {
      ...task,
      progress: params.progress,
      workflowProgress: params.workflowProgress,
      summary: params.summary ?? task.summary,
      agentCount: params.agentCount ?? task.agentCount,
    }
  })
}

export function completeWorkflowTask(
  taskId: string,
  result: WorkflowRunResult,
  setAppState: SetAppState,
): void {
  const completedAt = Date.now()
  let completed = false
  let toolUseId: string | undefined
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') {
      return task
    }

    completed = true
    toolUseId = task.toolUseId
    task.unregisterCleanup?.()
    task.agentControllers.clear()
    task.restartAgentHandlers.clear()
    task.skipAgentHandlers.clear()

    return {
      ...task,
      status: 'completed',
      result,
      endTime: completedAt,
      abortController: undefined,
      unregisterCleanup: undefined,
      ...finishPauseAccounting(task, completedAt),
      workflowProgress: task.workflowProgress.map(item => {
        if (item.type === 'workflow_phase') {
          return item.state === 'start' || item.state === 'progress' || item.state === undefined
            ? { ...item, state: 'done' as const }
            : item
        }
        return item.state === 'queued' || item.state === 'start' || item.state === 'progress'
          ? { ...item, state: 'done' as const, resultPreview: result.content }
          : item
      }),
    }
  })

  if (completed) {
    emitTaskUpdatedSdk(taskId, {
      status: 'completed',
      end_time: completedAt,
    }, { toolUseId })
    void evictTaskOutput(taskId)
  }
}

export function failWorkflowTask(
  taskId: string,
  agentId: string,
  error: string,
  setAppState: SetAppState,
): void {
  const failedAt = Date.now()
  let failed = false
  let toolUseId: string | undefined
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') {
      return task
    }

    failed = true
    toolUseId = task.toolUseId
    task.unregisterCleanup?.()
    task.agentControllers.clear()
    task.restartAgentHandlers.clear()
    task.skipAgentHandlers.clear()

    return {
      ...task,
      status: 'failed',
      error,
      endTime: failedAt,
      abortController: undefined,
      unregisterCleanup: undefined,
      ...finishPauseAccounting(task, failedAt),
      workflowProgress: withUpdatedWorkflowProgress(
        task.workflowProgress,
        agentId,
        'failed',
        error,
      ),
    }
  })

  if (failed) {
    emitTaskUpdatedSdk(taskId, {
      status: 'failed',
      end_time: failedAt,
    }, { toolUseId })
    void evictTaskOutput(taskId)
  }
}

export function enqueueWorkflowNotification({
  taskId,
  workflowName,
  description,
  status,
  error,
  setAppState,
  finalMessage,
  usage,
  toolUseId,
  worktreePath,
  worktreeBranch,
}: {
  taskId: string
  workflowName?: string
  description: string
  status: 'completed' | 'failed' | 'killed'
  error?: string
  setAppState: SetAppState
  finalMessage?: string
  usage?: {
    totalTokens: number
    toolUses: number
    durationMs: number
  }
  toolUseId?: string
  worktreePath?: string
  worktreeBranch?: string
}): void {
  if (!markWorkflowTaskNotified(taskId, setAppState)) {
    return
  }

  abortSpeculation(setAppState)

  const workflowLabel = workflowName ?? description
  const summary =
    status === 'completed'
      ? `Workflow "${workflowLabel}" completed`
      : status === 'failed'
        ? `Workflow "${workflowLabel}" failed: ${error || 'Unknown error'}`
        : `Workflow "${workflowLabel}" was stopped`

  const outputPath = getTaskOutputPath(taskId)
  const toolUseIdLine = toolUseId
    ? `\n<${TOOL_USE_ID_TAG}>${toolUseId}</${TOOL_USE_ID_TAG}>`
    : ''
  const resultSection = finalMessage ? `\n<result>${finalMessage}</result>` : ''
  const usageSection = usage
    ? `\n<usage><total_tokens>${usage.totalTokens}</total_tokens><tool_uses>${usage.toolUses}</tool_uses><duration_ms>${usage.durationMs}</duration_ms></usage>`
    : ''
  const worktreeSection = worktreePath
    ? `\n<${WORKTREE_TAG}><${WORKTREE_PATH_TAG}>${worktreePath}</${WORKTREE_PATH_TAG}>${worktreeBranch ? `<${WORKTREE_BRANCH_TAG}>${worktreeBranch}</${WORKTREE_BRANCH_TAG}>` : ''}</${WORKTREE_TAG}>`
    : ''

  const message = `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${taskId}</${TASK_ID_TAG}>${toolUseIdLine}
<${OUTPUT_FILE_TAG}>${outputPath}</${OUTPUT_FILE_TAG}>
<${STATUS_TAG}>${status}</${STATUS_TAG}>
<${SUMMARY_TAG}>${summary}</${SUMMARY_TAG}>${resultSection}${usageSection}${worktreeSection}
</${TASK_NOTIFICATION_TAG}>`

  enqueuePendingNotification({
    value: message,
    mode: 'task-notification',
  })
}

export const LocalWorkflowTask: Task = {
  name: 'LocalWorkflowTask',
  type: 'local_workflow',
  async kill(taskId, setAppState) {
    killWorkflowTask(taskId, setAppState)
  },
}

export function killWorkflowTask(
  taskId: string,
  setAppState: SetAppState,
): void {
  let killed = false
  let toolUseId: string | undefined
  let summary: string | undefined
  const stoppedAt = Date.now()

  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') {
      return task
    }

    killed = true
    toolUseId = task.toolUseId
    summary = task.workflowName ?? task.description

    task.abortController?.abort()
    task.unregisterCleanup?.()
    task.agentControllers.forEach(controller => controller.abort())
    task.agentControllers.clear()
    task.restartAgentHandlers.clear()
    task.skipAgentHandlers.clear()

    return {
      ...task,
      status: 'killed',
      endTime: stoppedAt,
      abortController: undefined,
      unregisterCleanup: undefined,
      ...finishPauseAccounting(task, stoppedAt),
      workflowProgress: task.workflowProgress.map(item => {
        if (item.type === 'workflow_phase') {
          return item.state === 'start' || item.state === 'progress'
            ? { ...item, state: 'error' as const }
            : item
        }
        return item.state === 'queued' || item.state === 'start' || item.state === 'progress'
          ? { ...item, state: 'error' as const, error: 'Workflow was stopped' }
          : item
      }),
    }
  })

  if (killed) {
    emitTaskUpdatedSdk(taskId, {
      status: 'stopped',
      end_time: stoppedAt,
    }, { toolUseId })
    emitTaskTerminatedSdk(taskId, 'stopped', {
      toolUseId,
      summary,
    })
    void evictTaskOutput(taskId)
  } else if (toolUseId || summary) {
    emitTaskTerminatedSdk(taskId, 'stopped', {
      toolUseId,
      summary,
    })
  }
}

export function restartWorkflowAgent(
  taskId: string,
  agentId: string,
  setAppState: SetAppState,
): void {
  let restartHandler: (() => void) | undefined

  setAppState(prev => {
    const task = prev.tasks[taskId]
    if (!isLocalWorkflowTask(task) || task.status !== 'running') {
      return prev
    }

    restartHandler = task.restartAgentHandlers.get(agentId)
    return prev
  })

  restartHandler?.()
}

export function skipWorkflowAgent(
  taskId: string,
  agentId: string,
  setAppState: SetAppState,
): void {
  let skipHandler: (() => void) | undefined

  setAppState(prev => {
    const task = prev.tasks[taskId]
    if (!isLocalWorkflowTask(task) || task.status !== 'running') {
      return prev
    }

    skipHandler = task.skipAgentHandlers.get(agentId)
    return prev
  })

  skipHandler?.()
}

export function pauseWorkflowTask(
  taskId: string,
  setAppState: SetAppState,
): void {
  let pauseController: WorkflowPauseController | undefined

  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running' || task.isPaused || !task.pauseController) {
      return task
    }

    pauseController = task.pauseController
    return {
      ...task,
      isPaused: true,
      pauseStartedAt: Date.now(),
    }
  })

  pauseController?.pause()
}

export function resumeWorkflowTask(
  taskId: string,
  setAppState: SetAppState,
): void {
  let resumeController: WorkflowPauseController | undefined
  let restartHandler: (() => void) | undefined

  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') {
      if (task.status === 'killed' || task.status === 'failed') {
        restartHandler = task.restartWorkflowHandler
      }
      return task
    }
    if (!task.isPaused || !task.pauseController) {
      return task
    }

    const now = Date.now()
    const pausedMs = task.pauseStartedAt
      ? Math.max(0, now - task.pauseStartedAt)
      : 0
    resumeController = task.pauseController
    return {
      ...task,
      isPaused: false,
      pauseStartedAt: undefined,
      totalPausedMs: (task.totalPausedMs ?? 0) + pausedMs,
    }
  })

  resumeController?.resume()
  if (!resumeController) {
    restartHandler?.()
  }
}

export function restartWorkflowTask(
  taskId: string,
  setAppState: SetAppState,
): void {
  let restartHandler: (() => void) | undefined
  let shouldStopCurrentRun = false

  setAppState(prev => {
    const task = prev.tasks[taskId]
    if (!isLocalWorkflowTask(task)) {
      return prev
    }

    restartHandler = task.restartWorkflowHandler
    shouldStopCurrentRun = task.status === 'running'
    return prev
  })

  if (!restartHandler) {
    return
  }

  if (shouldStopCurrentRun) {
    killWorkflowTask(taskId, setAppState)
  }
  restartHandler()
}
