import figures from 'figures'
import React, { useEffect, useMemo, useState } from 'react'
import type { TaskStatus } from 'src/Task.js'
import type { LocalWorkflowTaskState } from 'src/tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import type { SdkWorkflowProgress } from 'src/types/tools.js'
import type { DeepImmutable } from 'src/types/utils.js'
import type { CommandResultDisplay } from '../../commands.js'
import { useElapsedTime } from '../../hooks/useElapsedTime.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { Box, Text } from '../../ink.js'
import { formatNumber, truncateToWidth } from '../../utils/format.js'
import { plural } from '../../utils/stringUtils.js'
import { Byline } from '../design-system/Byline.js'
import { Dialog } from '../design-system/Dialog.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'
import { getTaskStatusColor, getTaskStatusIcon } from './taskStatusUtils.js'

type Props = {
  workflow: DeepImmutable<LocalWorkflowTaskState>
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
  onKill?: () => void
  onPause?: () => void
  onResume?: () => void
  onRestartWorkflow?: () => void
  onRestartAgent?: (agentId: string) => void
  onSkipAgent?: (agentId: string) => void
  onSave?: () => void
  onBack: () => void
}

type WorkflowPhaseProgress = Extract<
  SdkWorkflowProgress,
  { type: 'workflow_phase' }
>
type WorkflowAgentProgress = Extract<
  SdkWorkflowProgress,
  { type: 'workflow_agent' }
>

type PhaseRow = {
  index: number
  title: string
  detail?: string
  state?: WorkflowPhaseProgress['state']
  agents: DeepImmutable<WorkflowAgentProgress>[]
  completedAgents: number
  failedAgents: number
  runningAgents: number
}

function workflowStateToTaskStatus(
  state: WorkflowPhaseProgress['state'] | WorkflowAgentProgress['state'],
): TaskStatus | undefined {
  switch (state) {
    case 'queued':
      return 'pending'
    case 'start':
    case 'progress':
      return 'running'
    case 'done':
      return 'completed'
    case 'error':
      return 'failed'
    default:
      return undefined
  }
}

function statusColorForWorkflowState(
  state: WorkflowPhaseProgress['state'] | WorkflowAgentProgress['state'],
): string | undefined {
  const status = workflowStateToTaskStatus(state)
  return status ? getTaskStatusColor(status) : undefined
}

function statusIconForWorkflowState(
  state: WorkflowPhaseProgress['state'] | WorkflowAgentProgress['state'],
): string {
  const status = workflowStateToTaskStatus(state)
  return status ? getTaskStatusIcon(status) : figures.bullet
}

function workflowPausedMs(
  workflow: DeepImmutable<LocalWorkflowTaskState>,
): number {
  const currentPauseMs =
    workflow.isPaused && workflow.pauseStartedAt
      ? Math.max(0, Date.now() - workflow.pauseStartedAt)
      : 0
  return (workflow.totalPausedMs ?? 0) + currentPauseMs
}

function isWorkflowPhaseProgress(
  item: DeepImmutable<SdkWorkflowProgress>,
): item is DeepImmutable<WorkflowPhaseProgress> {
  return item.type === 'workflow_phase'
}

function isWorkflowAgentProgress(
  item: DeepImmutable<SdkWorkflowProgress>,
): item is DeepImmutable<WorkflowAgentProgress> {
  return item.type === 'workflow_agent'
}

function workflowTitle(workflow: DeepImmutable<LocalWorkflowTaskState>): string {
  return workflow.workflowName ?? workflow.summary ?? workflow.description
}

function workflowDescription(
  workflow: DeepImmutable<LocalWorkflowTaskState>,
): string {
  const title = workflowTitle(workflow)
  return workflow.summary && workflow.summary !== title
    ? workflow.summary
    : workflow.description
}

function formatDurationMs(durationMs: number | undefined): string | undefined {
  if (durationMs === undefined) return undefined
  const seconds = Math.max(0, Math.round(durationMs / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) {
    return remainingSeconds > 0
      ? `${minutes}m ${remainingSeconds}s`
      : `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`
}

function buildPhaseRows(
  workflowProgress: readonly DeepImmutable<SdkWorkflowProgress>[],
): PhaseRow[] {
  const phaseEntries = workflowProgress
    .filter(isWorkflowPhaseProgress)
    .sort((a, b) => a.index - b.index)
  const agentEntries = workflowProgress
    .filter(isWorkflowAgentProgress)
    .sort((a, b) => a.index - b.index)

  const phaseIndexes = new Set(phaseEntries.map(phase => phase.index))
  const syntheticPhaseIndexes = [
    ...new Set(
      agentEntries
        .map(agent => agent.phaseIndex)
        .filter(index => !phaseIndexes.has(index)),
    ),
  ].sort((a, b) => a - b)

  const phases = [
    ...phaseEntries.map(phase => ({
      index: phase.index,
      title: phase.title,
      detail: phase.detail,
      state: phase.state,
    })),
    ...syntheticPhaseIndexes.map(index => ({
      index,
      title: `Phase ${index}`,
      state: undefined,
    })),
  ].sort((a, b) => a.index - b.index)

  if (phases.length === 0 && agentEntries.length > 0) {
    phases.push({
      index: 1,
      title: 'Agents',
      state: undefined,
    })
  }

  return phases.map(phase => {
    const agents = agentEntries.filter(agent => agent.phaseIndex === phase.index)
    const completedAgents = agents.filter(agent => agent.state === 'done').length
    const failedAgents = agents.filter(agent => agent.state === 'error').length
    const runningAgents = agents.filter(
      agent => agent.state === 'start' || agent.state === 'progress',
    ).length
    const hasQueuedAgents = agents.some(agent => agent.state === 'queued')
    const state =
      failedAgents > 0
        ? 'error'
        : runningAgents > 0
          ? 'progress'
          : hasQueuedAgents
            ? 'start'
            : agents.length > 0 && completedAgents === agents.length
              ? 'done'
              : phase.state

    return {
      ...phase,
      state,
      agents,
      completedAgents,
      failedAgents,
      runningAgents,
    }
  })
}

function activePhaseIndex(phases: readonly PhaseRow[]): number | undefined {
  return (
    phases.find(
      phase =>
        phase.state === 'progress' ||
        phase.state === 'start' ||
        phase.agents.some(agent => agent.state === 'queued'),
    )?.index ??
    phases.find(phase => phase.state !== 'done')?.index ??
    phases[0]?.index
  )
}

function workflowStatusLabel(
  workflow: DeepImmutable<LocalWorkflowTaskState>,
): string {
  if (workflow.status === 'running' && workflow.isPaused) return 'paused'
  if (workflow.status === 'killed') return 'stopped'
  return workflow.status
}

function agentPreview(
  agent: DeepImmutable<WorkflowAgentProgress>,
): string | undefined {
  return agent.error ?? agent.resultPreview ?? agent.promptPreview
}

function agentMeta(agent: DeepImmutable<WorkflowAgentProgress>): string {
  return [
    agent.tokens ? `${formatNumber(agent.tokens)} tok` : null,
    agent.toolCalls
      ? `${agent.toolCalls} ${plural(agent.toolCalls, 'tool')}`
      : null,
    formatDurationMs(agent.durationMs),
  ]
    .filter(Boolean)
    .join(' - ')
}

function phaseCompletionText(phase: PhaseRow): string {
  if (phase.agents.length > 0) {
    const failed = phase.failedAgents > 0 ? `, ${phase.failedAgents} failed` : ''
    return `${phase.completedAgents}/${phase.agents.length}${failed}`
  }

  switch (phase.state) {
    case 'done':
      return 'done'
    case 'error':
      return 'failed'
    case 'progress':
    case 'start':
      return 'working'
    default:
      return ''
  }
}

function WorkflowSummaryRow({
  workflow,
  elapsedTime,
  width,
}: {
  workflow: DeepImmutable<LocalWorkflowTaskState>
  elapsedTime: string
  width: number
}): React.ReactNode {
  const tokenCount = workflow.result?.totalTokens ?? workflow.progress?.tokenCount
  const toolUseCount =
    workflow.result?.totalToolUseCount ?? workflow.progress?.toolUseCount
  const stats = [
    `${workflow.agentCount} ${plural(workflow.agentCount, 'agent')}`,
    elapsedTime,
    tokenCount && tokenCount > 0 ? `${formatNumber(tokenCount)} tok` : null,
    toolUseCount && toolUseCount > 0
      ? `${toolUseCount} ${plural(toolUseCount, 'tool')}`
      : null,
  ]
    .filter(Boolean)
    .join(' - ')
  const statusColor = getTaskStatusColor(workflow.status)
  const statusIcon = getTaskStatusIcon(workflow.status)
  const title = workflowTitle(workflow)
  const description = workflowDescription(workflow)
  const leftWidth = Math.max(24, Math.floor(width * 0.58))
  const rightWidth = Math.max(14, width - leftWidth - 4)

  return (
    <Box flexDirection="row" width={width}>
      <Box width={leftWidth}>
        <Text>
          <Text color={statusColor}>{statusIcon}</Text>{' '}
          <Text bold>{truncateToWidth(title, Math.max(1, leftWidth - 4))}</Text>
        </Text>
      </Box>
      <Box flexGrow={1}>
        <Text dimColor wrap="truncate-end">
          {truncateToWidth(description, Math.max(1, rightWidth))}
        </Text>
      </Box>
      <Box marginLeft={1}>
        <Text dimColor>{stats}</Text>
      </Box>
    </Box>
  )
}

function PhaseList({
  phases,
  selectedPhaseIndex,
  focused,
  width,
  onSelectPhase,
}: {
  phases: readonly PhaseRow[]
  selectedPhaseIndex: number | undefined
  focused: boolean
  width: number
  onSelectPhase: (phaseIndex: number) => void
}): React.ReactNode {
  return (
    <Box flexDirection="column" width={width}>
      <Text bold>Phases</Text>
      {phases.length === 0 ? (
        <Text dimColor>Starting...</Text>
      ) : (
        phases.map(phase => {
          const selected = phase.index === selectedPhaseIndex
          const completion = phaseCompletionText(phase)
          const prefix = selected ? '>' : ' '
          const line = `${prefix} ${phase.index} ${phase.title}`
          const countWidth = completion ? completion.length + 1 : 0
          const titleWidth = Math.max(1, width - countWidth - 4)

          return (
            <Box
              key={phase.index}
              flexDirection="row"
              width={width}
              onClick={() => onSelectPhase(phase.index)}
              onMouseEnter={() => onSelectPhase(phase.index)}
            >
              <Box width={titleWidth}>
                <Text color={selected && focused ? 'suggestion' : undefined}>
                  {line}{' '}
                  <Text color={statusColorForWorkflowState(phase.state)}>
                    {statusIconForWorkflowState(phase.state)}
                  </Text>
                </Text>
              </Box>
              {completion ? (
                <Text dimColor>{truncateToWidth(completion, countWidth)}</Text>
              ) : null}
            </Box>
          )
        })
      )}
    </Box>
  )
}

function AgentRow({
  agent,
  selected,
  focused,
  width,
  onSelect,
}: {
  agent: DeepImmutable<WorkflowAgentProgress>
  selected: boolean
  focused: boolean
  width: number
  onSelect: () => void
}): React.ReactNode {
  const modelWidth = Math.min(24, Math.max(10, Math.floor(width * 0.24)))
  const metaWidth = Math.min(28, Math.max(12, Math.floor(width * 0.28)))
  const labelWidth = Math.max(12, width - modelWidth - metaWidth - 4)
  const color = selected && focused ? 'suggestion' : undefined
  const meta = agentMeta(agent)

  return (
    <Box
      flexDirection="row"
      width={width}
      onClick={onSelect}
      onMouseEnter={onSelect}
    >
      <Box width={labelWidth}>
        <Text color={color}>
          {selected ? '> ' : '  '}
          <Text color={statusColorForWorkflowState(agent.state)}>
            {statusIconForWorkflowState(agent.state)}
          </Text>
          {truncateToWidth(agent.label, Math.max(1, labelWidth - 4))}
        </Text>
      </Box>
      <Box width={modelWidth}>
        <Text dimColor wrap="truncate-end">
          {agent.model ? truncateToWidth(agent.model, modelWidth - 1) : ''}
        </Text>
      </Box>
      <Box width={metaWidth}>
        <Text dimColor wrap="truncate-end">
          {truncateToWidth(meta, metaWidth)}
        </Text>
      </Box>
    </Box>
  )
}

function SelectedAgentDetails({
  agent,
}: {
  agent: DeepImmutable<WorkflowAgentProgress> | undefined
}): React.ReactNode {
  if (!agent) return null
  const preview = agentPreview(agent)

  if (!preview && !agent.lastAttemptReason) return null

  return (
    <Box flexDirection="column" marginTop={1}>
      {agent.lastAttemptReason ? (
        <Text color="warning" wrap="wrap">
          Retry reason: {agent.lastAttemptReason}
        </Text>
      ) : null}
      {preview ? (
        <Text
          color={agent.state === 'error' ? 'error' : undefined}
          dimColor={agent.state !== 'error'}
          wrap="truncate-end"
        >
          {truncateToWidth(preview, 220)}
        </Text>
      ) : null}
    </Box>
  )
}

function dashboardSubtitle(
  workflow: DeepImmutable<LocalWorkflowTaskState>,
  elapsedTime: string,
): React.ReactNode {
  const tokenCount = workflow.result?.totalTokens ?? workflow.progress?.tokenCount
  const toolUseCount =
    workflow.result?.totalToolUseCount ?? workflow.progress?.toolUseCount
  const statusColor = getTaskStatusColor(workflow.status)
  const statusIcon = getTaskStatusIcon(workflow.status)

  return (
    <Text>
      <Text color={statusColor}>
        {statusIcon} {workflowStatusLabel(workflow)}
      </Text>
      <Text dimColor>
        {' - '}
        {elapsedTime} - {workflow.agentCount} {plural(workflow.agentCount, 'agent')}
        {workflow.phaseTitles.length > 0 ? (
          <> - {workflow.phaseTitles.length} {plural(workflow.phaseTitles.length, 'phase')}</>
        ) : null}
        {tokenCount && tokenCount > 0 ? <> - {formatNumber(tokenCount)} tokens</> : null}
        {toolUseCount && toolUseCount > 0 ? (
          <> - {toolUseCount} {plural(toolUseCount, 'tool')}</>
        ) : null}
      </Text>
    </Text>
  )
}

export function WorkflowDashboard({
  workflow,
  onBack,
  onKill,
  onPause,
  onResume,
  onRestartWorkflow,
  onRestartAgent,
  onSkipAgent,
  onSave,
}: Omit<Props, 'onDone'>): React.ReactNode {
  const { columns } = useTerminalSize()
  const elapsedTime = useElapsedTime(
    workflow.startTime,
    workflow.status === 'running' && !workflow.isPaused,
    1000,
    workflowPausedMs(workflow),
    workflow.endTime,
  )
  const phases = useMemo(
    () => buildPhaseRows(workflow.workflowProgress),
    [workflow.workflowProgress],
  )
  // Latest log() narrator line emitted by the workflow script.
  const lastLog = useMemo(() => {
    for (let i = workflow.workflowProgress.length - 1; i >= 0; i--) {
      const entry = workflow.workflowProgress[i]
      if (entry?.type === 'workflow_log') {
        return entry.message
      }
    }
    return undefined
  }, [workflow.workflowProgress])
  const defaultPhaseIndex = activePhaseIndex(phases)
  const [selectedPhaseIndex, setSelectedPhaseIndex] = useState<
    number | undefined
  >(defaultPhaseIndex)
  const [selectedAgentIndex, setSelectedAgentIndex] = useState(0)
  const [focus, setFocus] = useState<'phases' | 'agents'>('phases')
  const [phaseSelectionLocked, setPhaseSelectionLocked] = useState(false)

  useEffect(() => {
    const selectedPhaseExists = phases.some(
      phase => phase.index === selectedPhaseIndex,
    )
    if (!phaseSelectionLocked || selectedPhaseIndex === undefined || !selectedPhaseExists) {
      setSelectedPhaseIndex(defaultPhaseIndex)
      setSelectedAgentIndex(0)
      if (!selectedPhaseExists) {
        setPhaseSelectionLocked(false)
      }
    }
  }, [defaultPhaseIndex, phaseSelectionLocked, phases, selectedPhaseIndex])

  const selectedPhase =
    phases.find(phase => phase.index === selectedPhaseIndex) ?? phases[0]
  const selectedAgents = selectedPhase?.agents ?? []
  const selectedAgent =
    selectedAgents[Math.min(selectedAgentIndex, selectedAgents.length - 1)]
  const selectedAgentRestartable = Boolean(
    selectedAgent?.agentId &&
      workflow.restartAgentHandlers.has(selectedAgent.agentId) &&
      onRestartAgent,
  )
  const selectedAgentSkippable = Boolean(
    selectedAgent?.agentId &&
      workflow.skipAgentHandlers.has(selectedAgent.agentId) &&
      onSkipAgent,
  )
  const contentWidth = Math.max(50, Math.min(columns - 6, 120))
  const phasePanelWidth = Math.min(30, Math.max(20, Math.floor(contentWidth * 0.32)))
  const agentPanelWidth = Math.max(24, contentWidth - phasePanelWidth - 4)

  useEffect(() => {
    if (selectedAgentIndex >= selectedAgents.length) {
      setSelectedAgentIndex(Math.max(0, selectedAgents.length - 1))
    }
  }, [selectedAgentIndex, selectedAgents.length])

  const selectPhaseAtOffset = (delta: number): void => {
    if (phases.length === 0) return
    const currentIndex = Math.max(
      0,
      phases.findIndex(phase => phase.index === selectedPhase?.index),
    )
    const nextIndex = Math.max(0, Math.min(phases.length - 1, currentIndex + delta))
    setSelectedPhaseIndex(phases[nextIndex]?.index)
    setSelectedAgentIndex(0)
    setPhaseSelectionLocked(true)
  }

  const handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'escape') {
      event.preventDefault()
      onBack?.()
      return
    }
    if (event.key === 'left') {
      event.preventDefault()
      if (focus === 'agents') {
        setFocus('phases')
      } else {
        onBack?.()
      }
      return
    }
    if (event.key === 'right' || event.key === 'return') {
      if (selectedAgents.length > 0) {
        event.preventDefault()
        setFocus('agents')
      }
      return
    }
    if (event.key === 'down' || event.key === 'j') {
      event.preventDefault()
      if (focus === 'agents') {
        setSelectedAgentIndex(index =>
          Math.min(index + 1, Math.max(0, selectedAgents.length - 1)),
        )
      } else {
        selectPhaseAtOffset(1)
      }
      return
    }
    if (event.key === 'up' || event.key === 'k') {
      event.preventDefault()
      if (focus === 'agents') {
        setSelectedAgentIndex(index => Math.max(0, index - 1))
      } else {
        selectPhaseAtOffset(-1)
      }
      return
    }
    if (event.key === 'x' && workflow.status === 'running' && onKill) {
      event.preventDefault()
      onKill()
      return
    }
    if (event.key === 'p') {
      if (workflow.status === 'running' && workflow.isPaused && onResume) {
        event.preventDefault()
        onResume()
        return
      }
      if (workflow.status === 'running' && !workflow.isPaused && onPause) {
        event.preventDefault()
        onPause()
        return
      }
      if (workflow.status !== 'running' && onResume) {
        event.preventDefault()
        onResume()
        return
      }
    }
    if (event.key === 's' && onSave) {
      event.preventDefault()
      onSave()
      return
    }
    if (event.key === 'r') {
      event.preventDefault()
      if (selectedAgentRestartable && selectedAgent?.agentId && onRestartAgent) {
        onRestartAgent(selectedAgent.agentId)
      } else {
        onRestartWorkflow?.()
      }
    }
    if (event.key === 'd') {
      if (selectedAgentSkippable && selectedAgent?.agentId && onSkipAgent) {
        event.preventDefault()
        onSkipAgent(selectedAgent.agentId)
      }
    }
  }

  return (
    <Box
      flexDirection="column"
      tabIndex={0}
      autoFocus
      onKeyDown={handleKeyDown}
      width={contentWidth}
    >
      <WorkflowSummaryRow
        workflow={workflow}
        elapsedTime={elapsedTime}
        width={contentWidth}
      />
      {lastLog ? (
        <Box marginTop={1} width={contentWidth}>
          <Text dimColor wrap="truncate-end">
            {'▸ '}
            {truncateToWidth(lastLog, Math.max(1, contentWidth - 2))}
          </Text>
        </Box>
      ) : null}
      <Box
        flexDirection="row"
        borderStyle="round"
        borderColor="background"
        paddingX={1}
        marginTop={1}
        width={contentWidth}
      >
        <Box
          flexDirection="column"
          width={phasePanelWidth}
          paddingRight={1}
          borderStyle="single"
          borderTop={false}
          borderBottom={false}
          borderLeft={false}
          borderColor="background"
        >
          <PhaseList
            phases={phases}
            selectedPhaseIndex={selectedPhase?.index}
            focused={focus === 'phases'}
            width={phasePanelWidth - 1}
            onSelectPhase={phaseIndex => {
              setSelectedPhaseIndex(phaseIndex)
              setSelectedAgentIndex(0)
              setPhaseSelectionLocked(true)
              setFocus('phases')
            }}
          />
        </Box>
        <Box flexDirection="column" paddingLeft={1} width={agentPanelWidth}>
          <Text bold>
            {selectedPhase?.title ?? 'Agents'}{' '}
            <Text dimColor>
              - {selectedAgents.length} {plural(selectedAgents.length, 'agent')}
            </Text>
          </Text>
          {selectedPhase?.detail ? (
            <Text dimColor wrap="truncate-end">
              {truncateToWidth(selectedPhase.detail, agentPanelWidth)}
            </Text>
          ) : null}
          {selectedAgents.length === 0 ? (
            <Text dimColor>
              {workflow.status === 'running' ? 'Waiting for agents...' : 'No agents recorded'}
            </Text>
          ) : (
            selectedAgents.map((agent, index) => (
              <AgentRow
                key={`${agent.index}:${agent.agentId ?? agent.label}`}
                agent={agent}
                selected={index === selectedAgentIndex}
                focused={focus === 'agents'}
                width={agentPanelWidth}
                onSelect={() => {
                  setSelectedAgentIndex(index)
                  setFocus('agents')
                }}
              />
            ))
          )}
          <SelectedAgentDetails agent={selectedAgent} />
        </Box>
      </Box>
      {workflow.status === 'completed' && workflow.result?.content ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="success">Result</Text>
          <Text wrap="wrap">{workflow.result.content}</Text>
        </Box>
      ) : null}
      {workflow.status === 'failed' && workflow.error ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="error">Error</Text>
          <Text color="error" wrap="wrap">{workflow.error}</Text>
        </Box>
      ) : null}
    </Box>
  )
}

export function WorkflowDetailDialog({
  workflow,
  onDone,
  onKill,
  onPause,
  onResume,
  onRestartWorkflow,
  onRestartAgent,
  onSkipAgent,
  onSave,
  onBack,
}: Props): React.ReactNode {
  const elapsedTime = useElapsedTime(
    workflow.startTime,
    workflow.status === 'running' && !workflow.isPaused,
    1000,
    workflowPausedMs(workflow),
    workflow.endTime,
  )

  const close = (
    result = 'Workflow dialog dismissed',
    options: { display?: CommandResultDisplay } = { display: 'system' },
  ): void => onDone(result, options)

  return (
    <Dialog
      title={workflowTitle(workflow)}
      subtitle={dashboardSubtitle(workflow, elapsedTime)}
      onCancel={onBack ?? close}
      color="background"
      inputGuide={() => (
        <Byline>
          <KeyboardShortcutHint shortcut="Up/Down" action="select" />
          <KeyboardShortcutHint shortcut="Enter/Right" action="agents" />
          <KeyboardShortcutHint shortcut="Left/Esc" action="back" />
          {workflow.status === 'running' && onKill ? (
            <KeyboardShortcutHint shortcut="x" action="stop" />
          ) : null}
          {workflow.status === 'running' && workflow.isPaused && onResume ? (
            <KeyboardShortcutHint shortcut="p" action="resume" />
          ) : workflow.status === 'running' && onPause ? (
            <KeyboardShortcutHint shortcut="p" action="pause" />
          ) : onResume ? (
            <KeyboardShortcutHint shortcut="p" action="resume" />
          ) : null}
          {onSave ? (
            <KeyboardShortcutHint shortcut="s" action="save as command" />
          ) : null}
          <KeyboardShortcutHint
            shortcut="r"
            action="restart agent / restart workflow"
          />
          {workflow.status === 'running' && onSkipAgent ? (
            <KeyboardShortcutHint shortcut="d" action="skip agent" />
          ) : null}
        </Byline>
      )}
    >
      <WorkflowDashboard
        workflow={workflow}
        onBack={onBack}
        onKill={onKill}
        onPause={onPause}
        onResume={onResume}
        onRestartWorkflow={onRestartWorkflow}
        onRestartAgent={onRestartAgent}
        onSkipAgent={onSkipAgent}
        onSave={onSave}
      />
    </Dialog>
  )
}
