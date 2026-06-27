import type {
  AssistantMessage,
  NormalizedUserMessage,
} from './message.js'

type ShellProgressBase = {
  output: string
  fullOutput: string
  elapsedTimeSeconds: number
  totalLines: number
  totalBytes: number
  timeoutMs?: number
  taskId?: string
}

export type BashProgress = ShellProgressBase & {
  type: 'bash_progress'
}

export type PowerShellProgress = ShellProgressBase & {
  type: 'powershell_progress'
}

export type ShellProgress = BashProgress | PowerShellProgress

export type MCPProgress = {
  type: 'mcp_progress'
  status: 'started' | 'progress' | 'completed' | 'failed'
  serverName: string
  toolName: string
  elapsedTimeMs?: number
  progress?: number
  total?: number
  progressMessage?: string
}

export type AgentToolProgress = {
  type: 'agent_progress'
  message: AssistantMessage | NormalizedUserMessage
  prompt: string
  agentId: string
}

export type SkillToolProgress = {
  type: 'skill_progress'
  message: AssistantMessage | NormalizedUserMessage
  prompt: string
  agentId: string
}

export type TaskOutputProgress = {
  type: 'waiting_for_task'
  taskDescription: string
  taskType?: string
}

export type SleepProgress = {
  type: 'sleep_progress'
  requestedMs: number
  sleptMs: number
  remainingMs: number
}

export type QueryUpdateProgress = {
  type: 'query_update'
  query: string
}

export type SearchResultsReceivedProgress = {
  type: 'search_results_received'
  query: string
  resultCount: number
}

export type WebSearchProgress =
  | QueryUpdateProgress
  | SearchResultsReceivedProgress

export type REPLToolProgress = {
  type: 'repl_tool_call'
  phase: string
  toolName: string
  toolInput: unknown
}

export type ToolProgressData =
  | BashProgress
  | PowerShellProgress
  | MCPProgress
  | AgentToolProgress
  | SkillToolProgress
  | TaskOutputProgress
  | SleepProgress
  | WebSearchProgress
  | REPLToolProgress

export type SdkWorkflowPhaseState = 'start' | 'progress' | 'done' | 'error'

export type SdkWorkflowAgentState =
  | 'queued'
  | 'start'
  | 'progress'
  | 'done'
  | 'error'

export type SdkWorkflowProgress =
  | {
      type: 'workflow_phase'
      index: number
      title: string
      state?: SdkWorkflowPhaseState
      detail?: string
    }
  | {
      type: 'workflow_agent'
      index: number
      label: string
      phaseIndex: number
      phaseTitle?: string
      agentId?: string
      model?: string
      state: SdkWorkflowAgentState
      queuedAt?: number
      startedAt?: number
      attempt?: number
      lastAttemptReason?: string
      promptPreview?: string
      lastProgressAt?: number
      tokens?: number
      toolCalls?: number
      durationMs?: number
      resultPreview?: string
      error?: string
    }
  | {
      type: 'workflow_log'
      message: string
      at?: number
    }

type ProgressWithType = {
  type: string
}

function hasProgressType(data: unknown): data is ProgressWithType {
  return (
    typeof data === 'object' &&
    data !== null &&
    'type' in data &&
    typeof (data as { type?: unknown }).type === 'string'
  )
}

export function isToolProgressData(data: unknown): data is ToolProgressData {
  if (!hasProgressType(data)) {
    return false
  }

  switch (data.type) {
    case 'bash_progress':
    case 'powershell_progress':
    case 'mcp_progress':
    case 'agent_progress':
    case 'skill_progress':
    case 'waiting_for_task':
    case 'sleep_progress':
    case 'query_update':
    case 'search_results_received':
    case 'repl_tool_call':
      return true
    default:
      return false
  }
}

export function isShellProgressData(
  data: unknown,
): data is ShellProgress {
  return (
    hasProgressType(data) &&
    (data.type === 'bash_progress' || data.type === 'powershell_progress')
  )
}

export function isReplToolProgressData(
  data: unknown,
): data is REPLToolProgress {
  return hasProgressType(data) && data.type === 'repl_tool_call'
}
