import { constants as fsConstants } from 'fs'
import { copyFile, mkdir } from 'fs/promises'
import { basename, join } from 'path'
import * as React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { getProjectRoot } from '../../bootstrap/state.js'
import { Select } from '../../components/CustomSelect/select.js'
import { Byline } from '../../components/design-system/Byline.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { KeyboardShortcutHint } from '../../components/design-system/KeyboardShortcutHint.js'
import { WorkflowDashboard } from '../../components/tasks/WorkflowDetailDialog.js'
import {
  getTaskStatusColor,
  getTaskStatusIcon,
} from '../../components/tasks/taskStatusUtils.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { Box, Text } from '../../ink.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import {
  killWorkflowTask,
  pauseWorkflowTask,
  restartWorkflowAgent,
  skipWorkflowAgent,
  restartWorkflowTask,
  resumeWorkflowTask,
  type LocalWorkflowTaskState,
} from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import type {
  CommandResultDisplay,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { truncateToWidth } from '../../utils/format.js'
import { plural } from '../../utils/stringUtils.js'

type WorkflowRun = LocalWorkflowTaskState

type ViewState =
  | { mode: 'dashboard' }
  | { mode: 'save'; taskId: string }

type SaveTarget = 'project' | 'user'

function isWorkflowRun(task: unknown): task is WorkflowRun {
  return (
    typeof task === 'object' &&
    task !== null &&
    'type' in task &&
    task.type === 'local_workflow'
  )
}

function countByStatus(
  workflows: readonly WorkflowRun[],
  status: WorkflowRun['status'],
): number {
  return workflows.filter(workflow => workflow.status === status).length
}

function workflowTitle(workflow: WorkflowRun): string {
  return workflow.workflowName ?? workflow.summary ?? workflow.description
}

function statusLabel(workflow: WorkflowRun): string {
  if (workflow.status === 'running' && workflow.isPaused) return 'paused'
  return workflow.status === 'killed' ? 'stopped' : workflow.status
}

function toSafeWorkflowFileName(workflow: WorkflowRun): string {
  const raw =
    workflow.workflowName ??
    (workflow.scriptPath ? basename(workflow.scriptPath, '.js') : workflow.id)
  return (
    raw
      .trim()
      .replace(/^\//, '')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || workflow.id
  )
}

async function saveWorkflowRunAsCommand(
  workflow: WorkflowRun,
  target: SaveTarget,
): Promise<string> {
  if (!workflow.scriptPath) {
    throw new Error('Workflow run has no persisted script path')
  }

  const targetDir =
    target === 'project'
      ? join(getProjectRoot(), '.claude', 'workflows')
      : join(getClaudeConfigHomeDir(), 'workflows')
  const targetPath = join(targetDir, `${toSafeWorkflowFileName(workflow)}.js`)
  await mkdir(targetDir, { recursive: true })
  await copyFile(workflow.scriptPath, targetPath, fsConstants.COPYFILE_EXCL)
  return targetPath
}

function WorkflowRunSwitcher({
  workflows,
  currentWorkflowId,
  onSelect,
}: {
  workflows: readonly WorkflowRun[]
  currentWorkflowId: string | undefined
  onSelect: (taskId: string) => void
}): React.ReactNode {
  if (workflows.length <= 1) return null

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text dimColor>Workflow runs</Text>
      {workflows.slice(0, 6).map(workflow => {
        const selected = workflow.id === currentWorkflowId
        const color = getTaskStatusColor(workflow.status)
        const icon = getTaskStatusIcon(workflow.status)
        const title = truncateToWidth(workflowTitle(workflow), 44)
        const stats = `${workflow.agentCount} ${plural(workflow.agentCount, 'agent')} - ${statusLabel(workflow)}`

        return (
          <Box
            key={workflow.id}
            flexDirection="row"
            onClick={() => onSelect(workflow.id)}
            onMouseEnter={() => onSelect(workflow.id)}
          >
            <Text color={selected ? 'suggestion' : undefined}>
              {selected ? '> ' : '  '}
              <Text color={color}>{icon}</Text> {title}
            </Text>
            <Text dimColor> {stats}</Text>
          </Box>
        )
      })}
      {workflows.length > 6 ? (
        <Text dimColor>{workflows.length - 6} more workflow runs hidden</Text>
      ) : null}
    </Box>
  )
}

function WorkflowRunsDialog({
  onDone,
}: {
  onDone: LocalJSXCommandOnDone
}): React.ReactNode {
  const tasks = useAppState(s => s.tasks)
  const setAppState = useSetAppState()
  const [viewState, setViewState] = useState<ViewState>({ mode: 'dashboard' })
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>()
  const [notice, setNotice] = useState<string | undefined>()

  const workflows = useMemo(
    () =>
      Object.values(tasks ?? {})
        .filter(isWorkflowRun)
        .sort((a, b) => {
          if (a.status === 'running' && b.status !== 'running') return -1
          if (a.status !== 'running' && b.status === 'running') return 1
          return (b.endTime ?? b.startTime) - (a.endTime ?? a.startTime)
        }),
    [tasks],
  )

  const currentWorkflow =
    workflows.find(workflow => workflow.id === selectedTaskId) ?? workflows[0]

  useEffect(() => {
    if (!currentWorkflow && workflows[0]) {
      setSelectedTaskId(workflows[0].id)
      return
    }
    if (
      selectedTaskId &&
      !workflows.some(workflow => workflow.id === selectedTaskId)
    ) {
      setSelectedTaskId(workflows[0]?.id)
    }
  }, [currentWorkflow, selectedTaskId, workflows])

  const close = (
    result = 'Workflows dialog dismissed',
    options: { display?: CommandResultDisplay } = { display: 'system' },
  ) => onDone(result, options)

  const saveWorkflow = (workflow: WorkflowRun, target: SaveTarget): void => {
    void saveWorkflowRunAsCommand(workflow, target)
      .then(path => setNotice(`Saved workflow command to ${path}`))
      .catch(error =>
        setNotice(
          error instanceof Error
            ? `Could not save workflow: ${error.message}`
            : `Could not save workflow: ${String(error)}`,
        ),
      )
  }

  const cycleWorkflow = (delta: number): void => {
    if (workflows.length === 0) return
    const currentIndex = Math.max(
      0,
      workflows.findIndex(workflow => workflow.id === currentWorkflow?.id),
    )
    const nextIndex =
      (currentIndex + delta + workflows.length) % workflows.length
    setSelectedTaskId(workflows[nextIndex]?.id)
  }

  const handleKeyDown = (event: KeyboardEvent): void => {
    if (viewState.mode !== 'dashboard') return
    if (event.key === '[') {
      event.preventDefault()
      cycleWorkflow(-1)
      return
    }
    if (event.key === ']') {
      event.preventDefault()
      cycleWorkflow(1)
    }
  }

  if (viewState.mode === 'save') {
    const workflow = workflows.find(item => item.id === viewState.taskId)
    if (!workflow) {
      return (
        <Dialog title="Save Workflow" onCancel={() => setViewState({ mode: 'dashboard' })}>
          <Text dimColor>Workflow run is no longer available.</Text>
        </Dialog>
      )
    }

    return (
      <Dialog
        title="Save Workflow"
        subtitle={workflowTitle(workflow)}
        onCancel={() => setViewState({ mode: 'dashboard' })}
        inputGuide={() => (
          <Byline>
            <KeyboardShortcutHint shortcut="Enter" action="save" />
            <KeyboardShortcutHint shortcut="Esc/Left" action="back" />
          </Byline>
        )}
      >
        <Select<SaveTarget>
          options={[
            {
              value: 'project' as const,
              label: <Text>Project command</Text>,
              description: '.claude/workflows',
            },
            {
              value: 'user' as const,
              label: <Text>User command</Text>,
              description: `${getClaudeConfigHomeDir()}\\workflows`,
            },
          ]}
          defaultValue="project"
          onChange={target => {
            saveWorkflow(workflow, target)
            setViewState({ mode: 'dashboard' })
          }}
          onCancel={() => setViewState({ mode: 'dashboard' })}
          hideIndexes
        />
      </Dialog>
    )
  }

  const runningCount = countByStatus(workflows, 'running')
  const completedCount = countByStatus(workflows, 'completed')
  const failedCount = countByStatus(workflows, 'failed')
  const stoppedCount = countByStatus(workflows, 'killed')
  const subtitle =
    workflows.length === 0
      ? 'No workflow runs'
      : `${runningCount} running - ${completedCount} completed - ${failedCount} failed - ${stoppedCount} stopped`

  if (!currentWorkflow) {
    return (
      <Dialog
        title="Workflows"
        subtitle={subtitle}
        onCancel={() => close()}
        inputGuide={() => (
          <Byline>
            <KeyboardShortcutHint shortcut="Esc" action="close" />
          </Byline>
        )}
      >
        <Text dimColor>
          Start a dynamic workflow and return here to monitor or manage it.
        </Text>
      </Dialog>
    )
  }

  return (
    <Box flexDirection="column" onKeyDown={handleKeyDown}>
      <Dialog
        title="Workflows"
        subtitle={subtitle}
        onCancel={() => close()}
        inputGuide={() => (
          <Byline>
            <KeyboardShortcutHint shortcut="Up/Down" action="select" />
            <KeyboardShortcutHint shortcut="Enter/Right" action="agents" />
            <KeyboardShortcutHint shortcut="Left/Esc" action="close" />
            {workflows.length > 1 ? (
              <KeyboardShortcutHint shortcut="[/]" action="switch workflow" />
            ) : null}
            {currentWorkflow.status === 'running' ? (
              <KeyboardShortcutHint shortcut="x" action="stop" />
            ) : null}
            {currentWorkflow.status !== 'completed' ? (
              <KeyboardShortcutHint
                shortcut="p"
                action={
                  currentWorkflow.status === 'running' && !currentWorkflow.isPaused
                    ? 'pause'
                    : 'resume'
                }
              />
            ) : null}
            <KeyboardShortcutHint shortcut="r" action="restart" />
            <KeyboardShortcutHint shortcut="s" action="save as command" />
          </Byline>
        )}
      >
        <WorkflowRunSwitcher
          workflows={workflows}
          currentWorkflowId={currentWorkflow.id}
          onSelect={setSelectedTaskId}
        />
        <WorkflowDashboard
          workflow={currentWorkflow}
          onBack={() => close()}
          onKill={
            currentWorkflow.status === 'running'
              ? () => killWorkflowTask(currentWorkflow.id, setAppState)
              : undefined
          }
          onPause={
            currentWorkflow.status === 'running' && !currentWorkflow.isPaused
              ? () => pauseWorkflowTask(currentWorkflow.id, setAppState)
              : undefined
          }
          onResume={
            currentWorkflow.isPaused ||
            currentWorkflow.status === 'killed' ||
            currentWorkflow.status === 'failed'
              ? () => resumeWorkflowTask(currentWorkflow.id, setAppState)
              : undefined
          }
          onRestartWorkflow={() =>
            restartWorkflowTask(currentWorkflow.id, setAppState)
          }
          onRestartAgent={agentId =>
            restartWorkflowAgent(currentWorkflow.id, agentId, setAppState)
          }
          onSkipAgent={agentId =>
            skipWorkflowAgent(currentWorkflow.id, agentId, setAppState)
          }
          onSave={() => setViewState({ mode: 'save', taskId: currentWorkflow.id })}
          key={`workflow-dashboard-${currentWorkflow.id}`}
        />
        {notice ? (
          <Box marginTop={1}>
            <Text dimColor wrap="wrap">
              {notice}
            </Text>
          </Box>
        ) : null}
      </Dialog>
    </Box>
  )
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: LocalJSXCommandContext,
): Promise<React.ReactNode> {
  return <WorkflowRunsDialog onDone={onDone} />
}
