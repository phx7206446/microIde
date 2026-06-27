import React, {
  Suspense,
  use,
  useDeferredValue,
  useEffect,
  useState,
} from 'react'
import type { CommandResultDisplay } from '../../commands.js'
import type { MonitorMcpTaskState } from 'src/tasks/MonitorMcpTask/MonitorMcpTask.js'
import type { DeepImmutable } from 'src/types/utils.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { Box, Text } from '../../ink.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import { formatDuration, formatFileSize, truncateToWidth } from '../../utils/format.js'
import { tailFile } from '../../utils/fsOperations.js'
import { getTaskOutputPath } from '../../utils/task/diskOutput.js'
import { Byline } from '../design-system/Byline.js'
import { Dialog } from '../design-system/Dialog.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'

type Props = {
  task: DeepImmutable<MonitorMcpTaskState>
  onDone: (
    result?: string,
    options?: {
      display?: CommandResultDisplay
    },
  ) => void
  onKill?: () => void
  onBack?: () => void
}

type TaskOutputResult = {
  content: string
  bytesTotal: number
}

const MONITOR_DETAIL_TAIL_BYTES = 8192

async function getTaskOutput(
  task: DeepImmutable<MonitorMcpTaskState>,
): Promise<TaskOutputResult> {
  const path = getTaskOutputPath(task.id)
  try {
    const result = await tailFile(path, MONITOR_DETAIL_TAIL_BYTES)
    return {
      content: result.content,
      bytesTotal: result.bytesTotal,
    }
  } catch {
    return {
      content: '',
      bytesTotal: 0,
    }
  }
}

export function MonitorMcpDetailDialog({
  task,
  onDone,
  onKill,
  onBack,
}: Props): React.ReactNode {
  const { columns } = useTerminalSize()
  const [outputPromise, setOutputPromise] = useState<Promise<TaskOutputResult>>(
    () => getTaskOutput(task),
  )
  const deferredOutputPromise = useDeferredValue(outputPromise)

  useEffect(() => {
    if (task.status !== 'running') {
      return
    }

    const timer = setInterval(() => {
      setOutputPromise(getTaskOutput(task))
    }, 1000)

    return () => clearInterval(timer)
  }, [task.id, task.status])

  const handleClose = () =>
    onDone('Monitor details dismissed', { display: 'system' })

  useKeybindings(
    {
      'confirm:yes': handleClose,
    },
    {
      context: 'Confirmation',
    },
  )

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === ' ') {
      e.preventDefault()
      handleClose()
      return
    }

    if (e.key === 'left' && onBack) {
      e.preventDefault()
      onBack()
      return
    }

    if (e.key === 'x' && task.status === 'running' && onKill) {
      e.preventDefault()
      onKill()
    }
  }

  const displayCommand = truncateToWidth(task.command, 280)
  const showCommand = !task.serverName && !task.resourceUri
  const runtime = formatDuration((task.endTime ?? Date.now()) - task.startTime)

  return (
    <Box flexDirection="column" tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
      <Dialog
        title="Monitor details"
        subtitle={task.description}
        onCancel={handleClose}
        color="background"
        inputGuide={exitState =>
          exitState.pending ? (
            <Text>Press {exitState.keyName} again to exit</Text>
          ) : (
            <Byline>
              {onBack ? (
                <KeyboardShortcutHint shortcut={"\u2190"} action="go back" />
              ) : null}
              <KeyboardShortcutHint shortcut="Esc/Enter/Space" action="close" />
              {task.status === 'running' && onKill ? (
                <KeyboardShortcutHint shortcut="x" action="stop" />
              ) : null}
            </Byline>
          )
        }
      >
        <Box flexDirection="column">
          <Text>
            <Text bold>Status:</Text>{' '}
            {task.status === 'running' ? (
              <Text color="background">running</Text>
            ) : task.status === 'completed' ? (
              <Text color="success">completed</Text>
            ) : task.status === 'killed' ? (
              <Text color="warning">killed</Text>
            ) : (
              <Text color="error">{task.status}</Text>
            )}
          </Text>
          <Text>
            <Text bold>Runtime:</Text> {runtime}
          </Text>
          {task.serverName ? (
            <Text>
              <Text bold>Server:</Text> {task.serverName}
            </Text>
          ) : null}
          {task.resourceUri ? (
            <Text wrap="wrap">
              <Text bold>Resource:</Text> {task.resourceUri}
            </Text>
          ) : null}
          {showCommand ? (
            <Text wrap="wrap">
              <Text bold>Command:</Text> {displayCommand}
            </Text>
          ) : null}

          <Box flexDirection="column" marginTop={1}>
            <Text bold>Output:</Text>
            <Suspense fallback={<Text dimColor>Loading output...</Text>}>
              <MonitorOutputContent
                outputPromise={deferredOutputPromise}
                columns={columns}
              />
            </Suspense>
          </Box>
        </Box>
      </Dialog>
    </Box>
  )
}

function MonitorOutputContent({
  outputPromise,
  columns,
}: {
  outputPromise: Promise<TaskOutputResult>
  columns: number
}): React.ReactNode {
  const { content, bytesTotal } = use(outputPromise) as TaskOutputResult

  if (!content) {
    return <Text dimColor>No output available</Text>
  }

  const starts: number[] = []
  let pos = content.length
  for (let i = 0; i < 10 && pos > 0; i++) {
    const prev = content.lastIndexOf('\n', pos - 1)
    starts.push(prev + 1)
    pos = prev
  }
  starts.reverse()

  const rendered: string[] = []
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]!
    const end = i < starts.length - 1 ? starts[i + 1]! - 1 : content.length
    const line = content.slice(start, end)
    if (line) {
      rendered.push(line)
    }
  }

  const isIncomplete = bytesTotal > content.length

  return (
    <>
      <Box
        borderStyle="round"
        paddingX={1}
        flexDirection="column"
        height={12}
        maxWidth={columns - 6}
      >
        {rendered.map((line, index) => (
          <Text key={index} wrap="truncate-end">
            {line}
          </Text>
        ))}
      </Box>
      <Text dimColor italic>
        {`Showing ${rendered.length} lines`}
        {isIncomplete ? ` of ${formatFileSize(bytesTotal)}` : ''}
      </Text>
    </>
  )
}
