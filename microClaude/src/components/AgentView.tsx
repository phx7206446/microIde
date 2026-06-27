import React, { useEffect, useEffectEvent, useRef, useState } from 'react'
import { Box, type Key, Text, useApp, useInput } from '../ink.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { stringWidth } from '../ink/stringWidth.js'
import { Divider } from './design-system/Divider.js'
import { Clawd } from './LogoV2/Clawd.js'
import { AlternateScreen } from '../ink/components/AlternateScreen.js'
import {
  createAgentJob,
  filterAgentJobs,
  type AgentDispatchDefaults,
  type AgentJobState,
  type AgentViewGroupMode,
  groupAgentJobs,
  inspectRemoveAgentJob,
  listAgentJobs,
  looksLikeAgentViewFilter,
  parseAgentViewFilter,
  removeAgentJob,
  replyAgentJob,
  stopAgentJob,
  toggleAgentJobPinned,
  updateAgentJobName,
} from '../utils/agentView.js'
import { getLogoDisplayData } from '../utils/logoV2Utils.js'
import { getMainLoopModel, renderModelName } from '../utils/model/model.js'

type Props = {
  cwd?: string
  dispatchDefaults?: AgentDispatchDefaults
  onOpenJob?: (job: AgentJobState) => void
  onClose?: () => void
}

type AgentViewGroup = {
  key: string
  label: string
  jobs: AgentJobState[]
}

type AgentViewItem =
  | { type: 'group'; group: AgentViewGroup; collapsed: boolean }
  | { type: 'job'; groupKey: string; job: AgentJobState }

function statusColor(
  status: AgentJobState['status'],
): 'success' | 'error' | 'warning' | undefined {
  switch (status) {
    case 'completed':
      return 'success'
    case 'failed':
    case 'stopped':
      return 'error'
    case 'needs_input':
    case 'ready_for_review':
      return 'warning'
    case 'idle':
    case 'working':
      return undefined
  }
}

function repeatSpaces(width: number): string {
  return width > 0 ? ' '.repeat(width) : ''
}

function truncateToDisplayWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  if (stringWidth(text) <= maxWidth) return text
  if (maxWidth <= 3) {
    let result = ''
    let width = 0
    for (const char of Array.from(text)) {
      const charWidth = stringWidth(char)
      if (width + charWidth > maxWidth) break
      result += char
      width += charWidth
    }
    return result
  }

  let result = ''
  let width = 0
  for (const char of Array.from(text)) {
    const charWidth = stringWidth(char)
    if (width + charWidth > maxWidth - 3) break
    result += char
    width += charWidth
  }
  return `${result}...`
}

function fitToWidth(text: string, width: number): string {
  const truncated = truncateToDisplayWidth(text, width)
  return `${truncated}${repeatSpaces(width - stringWidth(truncated))}`
}

function cleanLine(value: string | undefined): string {
  return value?.replace(/\s+/g, ' ').trim() ?? ''
}

function formatAge(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function statusIsRunning(status: AgentJobState['status']): boolean {
  return status === 'working' || status === 'needs_input' || status === 'idle'
}

function isPrintableAgentInput(input: string, key: Key): boolean {
  if (
    key.ctrl ||
    key.meta ||
    key.escape ||
    key.return ||
    key.tab ||
    key.backspace ||
    key.delete ||
    key.upArrow ||
    key.downArrow ||
    key.leftArrow ||
    key.rightArrow ||
    key.pageUp ||
    key.pageDown ||
    key.home ||
    key.end
  ) {
    return false
  }
  return input.length > 0 && !input.startsWith('\x1b')
}

function statusGroupLabel(status: AgentJobState['status']): string {
  switch (status) {
    case 'needs_input':
      return 'Needs input'
    case 'ready_for_review':
      return 'Ready for review'
    case 'working':
    case 'idle':
      return 'Working'
    case 'completed':
      return 'Completed'
    case 'failed':
      return 'Failed'
    case 'stopped':
      return 'Stopped'
  }
}

function statusIcon(status: AgentJobState['status']): string {
  switch (status) {
    case 'completed':
      return '*'
    case 'failed':
      return '!'
    case 'stopped':
      return 'x'
    case 'needs_input':
      return '?'
    case 'ready_for_review':
      return '>'
    case 'working':
      return '.'
    case 'idle':
      return '-'
  }
}

function buildAgentViewGroups(
  jobs: AgentJobState[],
  mode: AgentViewGroupMode,
): AgentViewGroup[] {
  if (mode === 'directory') {
    return groupAgentJobs(jobs, mode).map(group => ({
      key: `directory:${group.label}`,
      label: group.label,
      jobs: group.jobs,
    }))
  }

  const pinned = jobs.filter(job => job.pinned)
  const unpinned = jobs.filter(job => !job.pinned)
  const labels = [
    'Ready for review',
    'Needs input',
    'Working',
    'Failed',
    'Stopped',
    'Completed',
  ]
  return [
    ...(pinned.length > 0
      ? [
          {
            key: 'state:Pinned',
            label: 'Pinned',
            jobs: pinned.sort((a, b) => b.updatedAt - a.updatedAt),
          },
        ]
      : []),
    ...labels
    .map(label => ({
      key: `state:${label}`,
      label,
      jobs: unpinned
        .filter(job => statusGroupLabel(job.status) === label)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    }))
    .filter(group => group.jobs.length > 0),
  ]
}

function getDefaultCollapsedGroupKeys(): Set<string> {
  return new Set(['state:Completed'])
}

function buildAgentViewItems(
  groups: AgentViewGroup[],
  collapsedGroupKeys: Set<string>,
): AgentViewItem[] {
  const items: AgentViewItem[] = []
  for (const group of groups) {
    const collapsed = collapsedGroupKeys.has(group.key)
    items.push({ type: 'group', group, collapsed })
    if (!collapsed) {
      for (const job of group.jobs) {
        items.push({ type: 'job', groupKey: group.key, job })
      }
    }
  }
  return items
}

function getAgentTitle(job: AgentJobState): string {
  return cleanLine(job.name) || cleanLine(job.prompt) || job.sessionId
}

function getAgentDetail(job: AgentJobState, openingJobId?: string | null): string {
  if (job.id === openingJobId) return 'open'

  const result = cleanLine(job.lastResult)
  if (result) return result

  const lastPrompt = cleanLine(job.lastPrompt)
  if (lastPrompt) return `> ${lastPrompt}`

  if (job.status === 'working' || job.status === 'idle') return 'starting...'
  return cleanLine(job.prompt)
}

function getDisplayModel(dispatchDefaults?: AgentDispatchDefaults): string {
  if (dispatchDefaults?.model) return dispatchDefaults.model
  try {
    return renderModelName(getMainLoopModel())
  } catch {
    return 'default'
  }
}

function formatAgentRow(
  job: AgentJobState,
  columns: number,
  openingJobId?: string | null,
): { icon: string; rest: string; line: string } {
  const width = Math.max(20, columns)
  const icon = statusIcon(job.status)
  const age = formatAge(job.updatedAt)
  const ageWidth = stringWidth(age)
  const leftWidth = Math.min(46, Math.max(24, Math.floor(width * 0.32)))
  const detailWidth = Math.max(0, width - 2 - leftWidth - ageWidth - 1)
  const pinPrefix = job.pinned ? '* ' : ''
  const left = fitToWidth(`${pinPrefix}${getAgentTitle(job)}`, leftWidth)
  const detail = fitToWidth(getAgentDetail(job, openingJobId), detailWidth)
  const rest = ` ${left}${detail} ${age}`
  return {
    icon,
    rest,
    line: `${icon}${rest}`,
  }
}

function AgentViewHeader({
  jobs,
  cwd,
  dispatchDefaults,
}: {
  jobs: AgentJobState[]
  cwd?: string
  dispatchDefaults?: AgentDispatchDefaults
}): React.ReactNode {
  const logoData = getLogoDisplayData()
  const displayCwd = cwd ?? dispatchDefaults?.cwd ?? logoData.cwd
  const awaitingInput = jobs.filter(
    job => job.status === 'needs_input' || job.status === 'ready_for_review',
  ).length
  const working = jobs.filter(
    job => job.status === 'working' || job.status === 'idle',
  ).length
  const completed = jobs.filter(job => job.status === 'completed').length

  return (
    <Box flexDirection="row" gap={2}>
      <Clawd />
      <Box flexDirection="column">
        <Text>
          <Text bold>Claude Code</Text>{' '}
          <Text dimColor>v{logoData.version}</Text>
        </Text>
        <Text dimColor>
          [{logoData.billingType}] {getDisplayModel(dispatchDefaults)} ·{' '}
          {displayCwd}
        </Text>
        <Text dimColor>
          {awaitingInput} awaiting input · {working} working · {completed}{' '}
          completed
        </Text>
      </Box>
    </Box>
  )
}

function AgentViewRow({
  job,
  selected,
  columns,
  openingJobId,
  onClick,
  onMouseEnter,
}: {
  job: AgentJobState
  selected: boolean
  columns: number
  openingJobId?: string | null
  onClick: () => void
  onMouseEnter: () => void
}): React.ReactNode {
  const row = formatAgentRow(job, columns, openingJobId)
  if (selected) {
    return (
      <Box width={columns} height={1} onClick={onClick} onMouseEnter={onMouseEnter}>
        <Text>
          <Text color={statusColor(job.status)} inverse>{row.icon}</Text>
          <Text inverse>
            {row.rest}
            {repeatSpaces(Math.max(0, columns - stringWidth(row.line)))}
          </Text>
        </Text>
      </Box>
    )
  }

  return (
    <Box width={columns} height={1} onClick={onClick} onMouseEnter={onMouseEnter}>
      <Text>
        <Text color={statusColor(job.status)}>{row.icon}</Text>
        {row.rest}
        {repeatSpaces(Math.max(0, columns - stringWidth(row.line)))}
      </Text>
    </Box>
  )
}

function AgentViewGroupHeader({
  group,
  collapsed,
  selected,
  columns,
  onClick,
  onMouseEnter,
}: {
  group: AgentViewGroup
  collapsed: boolean
  selected: boolean
  columns: number
  onClick: () => void
  onMouseEnter: () => void
}): React.ReactNode {
  const label = collapsed ? `${group.label} ${group.jobs.length}` : group.label
  const line = fitToWidth(label, columns)
  if (selected) {
    return (
      <Box width={columns} height={1} onClick={onClick} onMouseEnter={onMouseEnter}>
        <Text inverse>{line}</Text>
      </Box>
    )
  }

  return (
    <Box width={columns} height={1} onClick={onClick} onMouseEnter={onMouseEnter}>
      <Text bold dimColor>{line}</Text>
    </Box>
  )
}

function CursorText({
  value,
  placeholder,
  cursorOffset,
}: {
  value: string
  placeholder: string
  cursorOffset: number
}): React.ReactNode {
  if (value.length > 0) {
    const offset = Math.max(0, Math.min(cursorOffset, value.length))
    const before = value.slice(0, offset)
    const cursor = offset < value.length ? value[offset]! : ' '
    const after = offset < value.length ? value.slice(offset + 1) : ''
    return (
      <Text>
        {before}
        <Text inverse>{cursor}</Text>
        {after}
      </Text>
    )
  }

  return (
    <Text dimColor>
      <Text inverse>{placeholder[0] ?? ' '}</Text>
      {placeholder.slice(1)}
    </Text>
  )
}

export function AgentView({ cwd, dispatchDefaults, onOpenJob, onClose }: Props): React.ReactNode {
  const { exit } = useApp()
  const close = onClose ?? exit
  const { columns, rows } = useTerminalSize()
  const contentWidth = Math.max(20, columns - 2)
  const [jobs, setJobs] = useState<AgentJobState[]>([])
  const [selected, setSelected] = useState(0)
  const [message, setMessage] = useState<string | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [promptCursor, setPromptCursor] = useState(0)
  const [filterQuery, setFilterQuery] = useState('')
  const [filterCursor, setFilterCursor] = useState(0)
  const [filterEditing, setFilterEditing] = useState(false)
  const [deleteArmedJob, setDeleteArmedJob] = useState<string | null>(null)
  const [dirtyDeleteArmedJob, setDirtyDeleteArmedJob] = useState<string | null>(
    null,
  )
  const [renameArmedJob, setRenameArmedJob] = useState<string | null>(null)
  const [groupMode, setGroupMode] = useState<AgentViewGroupMode>('state')
  const [openingJobId, setOpeningJobId] = useState<string | null>(null)
  const [replyTargetJobId, setReplyTargetJobId] = useState<string | null>(null)
  const openingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [collapsedGroupKeys, setCollapsedGroupKeys] = useState<Set<string>>(
    getDefaultCollapsedGroupKeys,
  )
  const activeFilterQuery =
    filterEditing || filterQuery
      ? filterQuery
      : looksLikeAgentViewFilter(prompt)
        ? prompt
        : ''
  const filteredJobs = filterAgentJobs(
    jobs,
    parseAgentViewFilter(activeFilterQuery),
  )
  const groups = buildAgentViewGroups(filteredJobs, groupMode)
  const visibleItems = buildAgentViewItems(groups, collapsedGroupKeys)
  const selectedItem = visibleItems[selected]
  const selectedJob =
    selectedItem?.type === 'job' ? selectedItem.job : undefined
  const replyTargetJob = replyTargetJobId
    ? jobs.find(job => job.id === replyTargetJobId)
    : undefined

  const toggleGroupCollapsed = (groupKey: string) => {
    setCollapsedGroupKeys(prev => {
      const next = new Set(prev)
      if (next.has(groupKey)) {
        next.delete(groupKey)
      } else {
        next.add(groupKey)
      }
      return next
    })
  }

  const clearPromptInput = () => {
    setPrompt('')
    setPromptCursor(0)
  }

  const clearFilterInput = () => {
    setFilterQuery('')
    setFilterCursor(0)
  }

  const setPromptInput = (value: string) => {
    setPrompt(value)
    setPromptCursor(value.length)
  }

  const insertPromptText = (text: string) => {
    const offset = Math.max(0, Math.min(promptCursor, prompt.length))
    setPrompt(`${prompt.slice(0, offset)}${text}${prompt.slice(offset)}`)
    setPromptCursor(offset + text.length)
  }

  const insertFilterText = (text: string) => {
    const offset = Math.max(0, Math.min(filterCursor, filterQuery.length))
    setFilterQuery(
      `${filterQuery.slice(0, offset)}${text}${filterQuery.slice(offset)}`,
    )
    setFilterCursor(offset + text.length)
  }

  const backspacePromptText = () => {
    const offset = Math.max(0, Math.min(promptCursor, prompt.length))
    if (offset === 0) return
    setPrompt(`${prompt.slice(0, offset - 1)}${prompt.slice(offset)}`)
    setPromptCursor(offset - 1)
  }

  const backspaceFilterText = () => {
    const offset = Math.max(0, Math.min(filterCursor, filterQuery.length))
    if (offset === 0) return
    setFilterQuery(`${filterQuery.slice(0, offset - 1)}${filterQuery.slice(offset)}`)
    setFilterCursor(offset - 1)
  }

  const movePromptCursor = (delta: number) => {
    setPromptCursor(prev => Math.max(0, Math.min(prompt.length, prev + delta)))
  }

  const moveFilterCursor = (delta: number) => {
    setFilterCursor(prev =>
      Math.max(0, Math.min(filterQuery.length, prev + delta)),
    )
  }

  const openAgentJob = (job: AgentJobState) => {
    if (openingJobId || openingTimeoutRef.current) return
    setOpeningJobId(job.id)
    clearPromptInput()
    setReplyTargetJobId(null)
    setRenameArmedJob(null)
    setDeleteArmedJob(null)
    setDirtyDeleteArmedJob(null)
    setMessage(null)
    openingTimeoutRef.current = setTimeout(() => {
      openingTimeoutRef.current = null
      onOpenJob?.(job)
      close()
    }, 50)
  }

  const refresh = useEffectEvent(async () => {
    try {
      const next = await listAgentJobs({ cwd })
      setJobs(next)
    } catch (error) {
      setMessage(toMessage(error))
    }
  })

  useEffect(() => {
    void refresh()
    const interval = setInterval(() => void refresh(), 1500)
    return () => clearInterval(interval)
  }, [refresh])

  useEffect(() => {
    setSelected(prev => Math.min(prev, Math.max(0, visibleItems.length - 1)))
  }, [visibleItems.length])

  useEffect(() => {
    setPromptCursor(prev => Math.max(0, Math.min(prompt.length, prev)))
  }, [prompt.length])

  useEffect(() => {
    setFilterCursor(prev => Math.max(0, Math.min(filterQuery.length, prev)))
  }, [filterQuery.length])

  useEffect(() => {
    if (replyTargetJobId && !replyTargetJob) {
      setReplyTargetJobId(null)
    }
  }, [replyTargetJob, replyTargetJobId])

  useEffect(() => {
    if (!deleteArmedJob) return
    const timeout = setTimeout(() => {
      setDeleteArmedJob(null)
      setDirtyDeleteArmedJob(null)
    }, 2000)
    return () => clearTimeout(timeout)
  }, [deleteArmedJob])

  useEffect(() => {
    return () => {
      if (openingTimeoutRef.current) clearTimeout(openingTimeoutRef.current)
    }
  }, [])

  useInput((input, key) => {
    if (openingJobId) {
      if (key.escape && openingTimeoutRef.current) {
        clearTimeout(openingTimeoutRef.current)
        openingTimeoutRef.current = null
        setOpeningJobId(null)
        return
      }
    if (key.ctrl && input === 'c') close()
      return
    }
    if (helpOpen) {
      if (key.escape || input === '?' || input === 'q' || (key.ctrl && input === 'c')) {
        setHelpOpen(false)
      }
      return
    }
    if (key.escape) {
      if (
        prompt ||
        filterEditing ||
        deleteArmedJob ||
        renameArmedJob ||
        replyTargetJobId ||
        helpOpen
      ) {
        clearPromptInput()
        clearFilterInput()
        setFilterEditing(false)
        setReplyTargetJobId(null)
        setDeleteArmedJob(null)
        setDirtyDeleteArmedJob(null)
        setRenameArmedJob(null)
        setMessage(null)
        return
      }
      close()
      return
    }
    if (input === '?' && prompt.length === 0 && !filterEditing) {
      setHelpOpen(true)
      return
    }
    if (input === 'q' && prompt.length === 0 && !filterEditing) {
      close()
      return
    }
    if (key.backspace) {
      if (filterEditing) {
        backspaceFilterText()
      } else {
        backspacePromptText()
      }
      return
    }
    if (input === '/' && prompt.length === 0 && !filterEditing) {
      setFilterEditing(true)
      setFilterCursor(filterQuery.length)
      setMessage('Filter: use a:<agent>, s:<state>, #<pr>, or text')
      return
    }
    if (key.ctrl && input === 'f') {
      setFilterEditing(prev => {
        const next = !prev
        if (next) setFilterCursor(filterQuery.length)
        return next
      })
      return
    }
    if (key.ctrl && input === 's') {
      setGroupMode(prev => (prev === 'state' ? 'directory' : 'state'))
      return
    }
    if (key.downArrow) {
      setSelected(prev =>
        Math.min(prev + 1, Math.max(0, visibleItems.length - 1)),
      )
      return
    }
    if (key.upArrow) {
      setSelected(prev => Math.max(0, prev - 1))
      return
    }

    const job = selectedJob
    if (key.return) {
      if (filterEditing) {
        setFilterEditing(false)
        setMessage(null)
        return
      }
      const text = prompt.trim()
      if (text && looksLikeAgentViewFilter(text) && filteredJobs.length > 0) {
        setMessage(
          `Filtered ${filteredJobs.length} background agent${filteredJobs.length === 1 ? '' : 's'}. Clear the prompt and press Enter to attach the selected session.`,
        )
        return
      }
      if (text && renameArmedJob && job) {
        void updateAgentJobName(job.id, text).then(
          updated => {
            clearPromptInput()
            setRenameArmedJob(null)
            setReplyTargetJobId(null)
            setDirtyDeleteArmedJob(null)
            setMessage(`Renamed ${updated.id}`)
            void refresh()
          },
          error => setMessage(toMessage(error)),
        )
        return
      }
      if (text && replyTargetJobId) {
        void replyAgentJob(replyTargetJobId, text).then(
          updated => {
            clearPromptInput()
            setReplyTargetJobId(null)
            setRenameArmedJob(null)
            setDeleteArmedJob(null)
            setDirtyDeleteArmedJob(null)
            setMessage(`Sent reply to ${updated.id}`)
            void refresh()
          },
          error => setMessage(toMessage(error)),
        )
        return
      }
      if (!text && selectedItem?.type === 'group') {
        toggleGroupCollapsed(selectedItem.group.key)
        return
      }
      if (text) {
        void createAgentJob({
          cwd: dispatchDefaults?.cwd ?? cwd ?? process.cwd(),
          rootCwd: dispatchDefaults?.rootCwd ?? cwd ?? process.cwd(),
          prompt: text,
          args: dispatchDefaults?.args ?? [],
          model: dispatchDefaults?.model,
          effort: dispatchDefaults?.effort,
          permissionMode: dispatchDefaults?.permissionMode,
          agent: dispatchDefaults?.agent,
          name: dispatchDefaults?.name,
        }).then(
          state => {
            clearPromptInput()
            setReplyTargetJobId(null)
            setRenameArmedJob(null)
            setDeleteArmedJob(null)
            setDirtyDeleteArmedJob(null)
            if (key.shift) {
              openAgentJob(state)
              return
            }
            setMessage(`Started ${state.id}`)
            void refresh()
          },
          error => setMessage(toMessage(error)),
        )
        return
      }
      if (job) {
        openAgentJob(job)
      }
      return
    }
    if (key.leftArrow && filterEditing) {
      moveFilterCursor(-1)
      return
    }
    if (key.rightArrow && filterEditing) {
      moveFilterCursor(1)
      return
    }
    if (key.leftArrow && prompt.length > 0) {
      movePromptCursor(-1)
      return
    }
    if (key.rightArrow && prompt.length > 0) {
      movePromptCursor(1)
      return
    }
    if (key.rightArrow && job) {
      openAgentJob(job)
      return
    }
    if (key.ctrl && input === 'a' && job) {
      openAgentJob(job)
      return
    }
    if (key.ctrl && input === 'x' && job) {
      if (statusIsRunning(job.status)) {
        void stopAgentJob(job.id).then(
          next => {
            setDeleteArmedJob(null)
            setDirtyDeleteArmedJob(null)
            setMessage(`Stopped ${next.id}`)
            void refresh()
          },
          error => setMessage(toMessage(error)),
        )
      } else if (deleteArmedJob === job.id) {
        void inspectRemoveAgentJob(job.id).then(
          inspection => {
            if (inspection.hasWorktreeChanges && dirtyDeleteArmedJob !== job.id) {
              setDirtyDeleteArmedJob(job.id)
              setMessage(
                `Worktree has changes: ${inspection.worktreePath}. Press Ctrl+X again within 2s to discard and delete.`,
              )
              return
            }
            void removeAgentJob(job.id, {
              discardWorktreeChanges: dirtyDeleteArmedJob === job.id,
            }).then(
              removed => {
                setDeleteArmedJob(null)
                setDirtyDeleteArmedJob(null)
                if (replyTargetJobId === removed.id) setReplyTargetJobId(null)
                setMessage(`Deleted ${removed.id}`)
                void refresh()
              },
              error => setMessage(toMessage(error)),
            )
          },
          error => setMessage(toMessage(error)),
        )
      } else {
        setDeleteArmedJob(job.id)
        setDirtyDeleteArmedJob(null)
        setMessage(`Press Ctrl+X again to delete ${job.id}`)
      }
      return
    }
    if (key.ctrl && input === 't' && job) {
      void toggleAgentJobPinned(job.id).then(
        updated => {
          setMessage(`${updated.pinned ? 'Pinned' : 'Unpinned'} ${updated.id}`)
          void refresh()
        },
        error => setMessage(toMessage(error)),
      )
      return
    }
    if (key.ctrl && input === 'r' && job) {
      if (prompt.trim().length === 0) {
        setRenameArmedJob(job.id)
        setReplyTargetJobId(null)
        setPromptInput(job.name ?? '')
        setMessage(`Rename ${job.id}, then press Enter`)
        setDirtyDeleteArmedJob(null)
        return
      }
      if (renameArmedJob === job.id) {
        void updateAgentJobName(job.id, prompt.trim()).then(
          updated => {
            clearPromptInput()
            setRenameArmedJob(null)
            setDirtyDeleteArmedJob(null)
            setMessage(`Renamed ${updated.id}`)
            void refresh()
          },
          error => setMessage(toMessage(error)),
        )
        return
      }
      setMessage(`Finish renaming ${renameArmedJob} or press Ctrl+C to clear`)
      return
    }
    if (input === ' ' && prompt.length === 0 && !filterEditing) {
      if (!job) return
      setReplyTargetJobId(job.id)
      setRenameArmedJob(null)
      setDeleteArmedJob(null)
      setDirtyDeleteArmedJob(null)
      setMessage(`Reply to ${job.id}; type a message and press Enter`)
      return
    }
    if (key.ctrl && input === 'c') {
      setMessage(null)
      if (prompt) clearPromptInput()
      if (filterEditing) setFilterEditing(false)
      setDeleteArmedJob(null)
      setDirtyDeleteArmedJob(null)
      setRenameArmedJob(null)
      setReplyTargetJobId(null)
      return
    }
    if (isPrintableAgentInput(input, key)) {
      if (filterEditing) {
        insertFilterText(input)
      } else {
        insertPromptText(input)
      }
    }
  })

  const inputValue = filterEditing ? filterQuery : prompt
  const inputCursor = filterEditing ? filterCursor : promptCursor
  const footerShortcutText = filterEditing
    ? 'enter to apply - esc to clear'
    : prompt
      ? renameArmedJob
        ? 'enter to rename - esc to clear'
        : replyTargetJob
          ? 'enter to reply - esc to clear'
          : 'enter to create - esc to clear'
      : replyTargetJob
        ? 'type a message to reply - esc to clear'
        : selectedItem?.type === 'group'
          ? `enter to ${selectedItem.collapsed ? 'expand' : 'collapse'} - ? for shortcuts`
          : 'enter/right to open - space to reply - ctrl+x to delete - ? for shortcuts'
  const inputPlaceholder = filterEditing
      ? 'filter agents'
      : renameArmedJob
        ? 'rename selected agent'
        : replyTargetJob
          ? `reply to ${truncateToDisplayWidth(getAgentTitle(replyTargetJob), 32)}`
        : 'start a task in the background'
  return (
    <AlternateScreen mouseTracking>
      <Box flexDirection="column" height={rows} width={columns} paddingX={1}>
        <>
            <Box flexShrink={0}>
              <AgentViewHeader
                jobs={filteredJobs}
                cwd={cwd}
                dispatchDefaults={dispatchDefaults}
              />
            </Box>

            <Box
              flexDirection="column"
              flexGrow={1}
              marginTop={1}
              overflow="hidden"
            >
              {activeFilterQuery ? (
                <Text dimColor>Filter: {activeFilterQuery}</Text>
              ) : null}
              {filteredJobs.length === 0 ? (
                <Text>No background agents.</Text>
              ) : (
                visibleItems.map((item, index) =>
                  item.type === 'group' ? (
                    <Box key={item.group.key} marginTop={index === 0 ? 0 : 1}>
                      <AgentViewGroupHeader
                        group={item.group}
                        collapsed={item.collapsed}
                        selected={index === selected}
                        columns={contentWidth}
                        onClick={() => {
                          setSelected(index)
                          toggleGroupCollapsed(item.group.key)
                        }}
                        onMouseEnter={() => setSelected(index)}
                      />
                    </Box>
                  ) : (
                    <AgentViewRow
                      key={item.job.id}
                      job={item.job}
                      selected={index === selected}
                      columns={contentWidth}
                      openingJobId={openingJobId}
                      onClick={() => {
                        setSelected(index)
                        openAgentJob(item.job)
                      }}
                      onMouseEnter={() => setSelected(index)}
                    />
                  ),
                )
              )}
            </Box>

            {helpOpen ? (
              <Box flexDirection="column" borderStyle="round" paddingX={1}>
                <Text bold>Shortcuts</Text>
                <Text dimColor>
                  enter open selected, toggle group, or create typed task
                </Text>
                <Text dimColor>space reply to selected agent</Text>
                <Text dimColor>
                  ctrl+x stop running agent or delete stopped agent
                </Text>
                <Text dimColor>
                  / filter · ctrl+r rename · ctrl+t pin · ctrl+s group
                </Text>
              </Box>
            ) : null}
        </>
        {message ? <Text color="warning">{message}</Text> : null}

        <Box flexShrink={0} flexDirection="column">
          <Divider width={contentWidth} />
          <Box>
            <Text bold>❯ </Text>
            <CursorText
              value={inputValue}
              placeholder={inputPlaceholder}
              cursorOffset={inputCursor}
            />
          </Box>
          <Divider width={contentWidth} />
          <Box paddingLeft={3}>
            <Text dimColor>{footerShortcutText}</Text>
          </Box>
        </Box>
      </Box>
    </AlternateScreen>
  )
}
