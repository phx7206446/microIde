import React from 'react'
import { Select } from '../components/CustomSelect/index.js'
import { Dialog } from '../components/design-system/Dialog.js'
import { Box, Text } from '../ink.js'
import type { AssistantSession } from './sessionDiscovery.js'

type AssistantSessionChooserProps = {
  sessions: AssistantSession[]
  onSelect: (id: string) => void
  onCancel: () => void
}

function formatStatus(status: string): string {
  switch (status) {
    case 'requires_action':
      return 'Requires action'
    case 'running':
      return 'Running'
    case 'idle':
      return 'Idle'
    default:
      return status
  }
}

function formatUpdatedAt(value: string): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return 'unknown time'
  }
  return parsed.toLocaleString()
}

export function AssistantSessionChooser({
  sessions,
  onSelect,
  onCancel,
}: AssistantSessionChooserProps): React.ReactNode {
  const options = sessions.map(session => ({
    label: session.title,
    value: session.id,
    description: `${formatStatus(session.status)} - ${session.id.slice(0, 8)} - updated ${formatUpdatedAt(session.updatedAt)}`,
  }))

  return (
    <Dialog
      title="Choose Assistant Session"
      subtitle="Attach to a running assistant session"
      onCancel={onCancel}
    >
      <Box flexDirection="column" gap={1}>
        <Text dimColor>Select the session you want this viewer to follow.</Text>
        <Select
          defaultFocusValue={sessions[0]?.id}
          options={options}
          onChange={onSelect}
          onCancel={onCancel}
          visibleOptionCount={Math.min(8, Math.max(1, sessions.length))}
        />
      </Box>
    </Dialog>
  )
}
