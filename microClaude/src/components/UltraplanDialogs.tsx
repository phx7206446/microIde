import type { UUID } from 'crypto'
import React, { useCallback, useMemo } from 'react'
import { useAppState, useSetAppState } from '../state/AppState.js'
import type { AppState } from '../state/AppStateStore.js'
import type { Message } from '../types/message.js'
import type { FileStateCache } from '../utils/fileStateCache.js'
import { createUserMessage } from '../utils/messages.js'
import { archiveRemoteSession } from '../utils/teleport.js'
import { updateTaskState } from '../utils/task/framework.js'
import { Box, Text } from '../ink.js'
import { Select, type OptionWithDescription } from './CustomSelect/index.js'
import { Markdown } from './Markdown.js'
import { PermissionDialog } from './permissions/PermissionDialog.js'

type UltraplanLaunchDialogChoice = 'launch' | 'cancel' | 'disconnect-and-launch'
type UltraplanPlanChoice = 'implement-here' | 'start-fresh'

function buildPlanPreview(plan: string, maxLines = 14): string {
  const trimmed = plan.trim()
  const lines = trimmed.split(/\r?\n/)
  if (lines.length <= maxLines) {
    return trimmed
  }
  return [...lines.slice(0, maxLines), '', `... (${lines.length - maxLines} more lines)`].join('\n')
}

type UltraplanChoiceDialogProps = {
  plan: string
  sessionId: string
  taskId: string
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>
  readFileState: FileStateCache
  getAppState: () => AppState
  setConversationId: React.Dispatch<React.SetStateAction<UUID>>
}

export function UltraplanChoiceDialog({
  plan,
  sessionId,
  taskId,
  setMessages: _setMessages,
  readFileState: _readFileState,
  getAppState,
  setConversationId: _setConversationId,
}: UltraplanChoiceDialogProps): React.ReactNode {
  const setAppState = useSetAppState()
  const preview = useMemo(() => buildPlanPreview(plan), [plan])
  const planLineCount = useMemo(() => plan.trim().split(/\r?\n/).length, [plan])

  const handleChoice = useCallback(
    (choice: UltraplanPlanChoice): void => {
      const current = getAppState().ultraplanPendingChoice
      if (!current || current.taskId !== taskId || current.sessionId !== sessionId) {
        return
      }

      const seededMessage = {
        ...createUserMessage({
          content: `Implement the following plan:\n\n${plan}`,
        }),
        planContent: plan,
      }

      updateTaskState(taskId, setAppState, task =>
        task.status !== 'running'
          ? task
          : {
              ...task,
              status: 'completed',
              endTime: Date.now(),
            },
      )

      setAppState(prev => ({
        ...prev,
        ultraplanPendingChoice: undefined,
        ultraplanSessionUrl: undefined,
        initialMessage: {
          message: seededMessage,
          clearContext: choice === 'start-fresh',
        },
      }))

      void archiveRemoteSession(sessionId)
    },
    [getAppState, plan, sessionId, setAppState, taskId],
  )

  const options: OptionWithDescription<UltraplanPlanChoice>[] = useMemo(
    () => [
      {
        value: 'implement-here',
        label: 'Implement here',
        description:
          'Keep this session and send the approved plan back into the current transcript.',
      },
      {
        value: 'start-fresh',
        label: 'Start fresh',
        description:
          'Clear the current transcript first, then seed a new session with this approved plan.',
      },
    ],
    [],
  )

  return (
    <PermissionDialog
      title="Ultraplan ready"
      subtitle="Choose how to continue with the approved plan."
      innerPaddingX={2}
    >
      <Box flexDirection="column" gap={1}>
        <Text dimColor>{planLineCount} lines approved in Claude Code on the web.</Text>
        <Box
          borderStyle="dashed"
          borderColor="subtle"
          borderLeft={false}
          borderRight={false}
          flexDirection="column"
          paddingX={1}
        >
          <Markdown>{preview}</Markdown>
        </Box>
        <Select options={options} onChange={handleChoice} />
      </Box>
    </PermissionDialog>
  )
}

type UltraplanLaunchDialogProps = {
  onChoice: (choice: 'launch' | 'cancel', opts?: { disconnectedBridge?: boolean }) => void
}

export function UltraplanLaunchDialog({
  onChoice,
}: UltraplanLaunchDialogProps): React.ReactNode {
  const replBridgeEnabled = useAppState(state => state.replBridgeEnabled)
  const replBridgeOutboundOnly = useAppState(state => state.replBridgeOutboundOnly)
  const setAppState = useSetAppState()
  const shouldOfferDisconnect = replBridgeEnabled && !replBridgeOutboundOnly

  const handleChoice = useCallback(
    (choice: UltraplanLaunchDialogChoice): void => {
      if (choice === 'cancel') {
        onChoice('cancel')
        return
      }

      if (choice === 'disconnect-and-launch') {
        setAppState(prev =>
          prev.replBridgeEnabled
            ? {
                ...prev,
                replBridgeEnabled: false,
              }
            : prev,
        )
        onChoice('launch', {
          disconnectedBridge: true,
        })
        return
      }

      onChoice('launch')
    },
    [onChoice, setAppState],
  )

  const options: OptionWithDescription<UltraplanLaunchDialogChoice>[] = useMemo(
    () =>
      shouldOfferDisconnect
        ? [
            {
              value: 'disconnect-and-launch',
              label: 'Disconnect and launch',
              description:
                'Turn off Remote Control for this session first, then start Ultraplan.',
            },
            {
              value: 'launch',
              label: 'Launch anyway',
              description: 'Keep Remote Control connected and start Ultraplan immediately.',
            },
            {
              value: 'cancel',
              label: 'Cancel',
              description: 'Do not start a Claude Code on the web session right now.',
            },
          ]
        : [
            {
              value: 'launch',
              label: 'Launch Ultraplan',
              description:
                'Start a Claude Code on the web planning session and keep this terminal free.',
            },
            {
              value: 'cancel',
              label: 'Cancel',
              description: 'Do not start a Claude Code on the web session right now.',
            },
          ],
    [shouldOfferDisconnect],
  )

  return (
    <PermissionDialog
      title="Launch Ultraplan"
      subtitle="Ultraplan runs on Claude Code on the web and returns the approved plan here."
      innerPaddingX={2}
    >
      <Box flexDirection="column" gap={1}>
        <Text>
          The remote session will keep planning in Claude Code on the web while this
          terminal stays available.
        </Text>
        {shouldOfferDisconnect ? (
          <Text dimColor>
            Remote Control is currently connected to this session. You can disconnect it
            first before launching Ultraplan.
          </Text>
        ) : null}
        <Select
          options={options}
          onChange={handleChoice}
          onCancel={() => onChoice('cancel')}
        />
      </Box>
    </PermissionDialog>
  )
}
