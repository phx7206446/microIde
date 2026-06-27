import { join } from 'path'
import React, { useCallback, useMemo, useState } from 'react'
import { Box, Text } from '../../ink.js'
import {
  type AgentMemoryScope,
  getAgentMemoryDir,
  getMemoryScopeDisplay,
} from '../../tools/AgentTool/agentMemory.js'
import {
  getSnapshotDirForAgent,
  markSnapshotSynced,
  replaceFromSnapshot,
} from '../../tools/AgentTool/agentMemorySnapshot.js'
import type { OptionWithDescription } from '../CustomSelect/index.js'
import { Select } from '../CustomSelect/index.js'
import { Dialog } from '../design-system/Dialog.js'
import { Spinner } from '../Spinner.js'

const SYNCED_JSON = '.snapshot-synced.json'

type SnapshotChoice = 'merge' | 'keep' | 'replace'

type Props = {
  agentType: string
  scope: AgentMemoryScope
  snapshotTimestamp: string
  onComplete: (choice: SnapshotChoice) => void
  onCancel: () => void
}

function formatError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message
  }

  return String(error)
}

export function buildMergePrompt(
  agentType: string,
  scope: AgentMemoryScope,
  snapshotTimestamp: string,
): string {
  const snapshotDir = getSnapshotDirForAgent(agentType)
  const localMemoryDir = getAgentMemoryDir(agentType, scope)
  const syncedMetadataPath = join(localMemoryDir, SYNCED_JSON)
  const syncedMetadata = JSON.stringify({ syncedFrom: snapshotTimestamp })

  return [
    `A newer project snapshot is available for the "${agentType}" agent memory.`,
    `Memory scope: ${getMemoryScopeDisplay(scope)}`,
    '',
    `Snapshot directory (read only): ${snapshotDir}`,
    `Local memory directory (apply updates here): ${localMemoryDir}`,
    '',
    'Before continuing with the user request:',
    `1. Read the markdown files in ${snapshotDir} and compare them with the markdown files in ${localMemoryDir}.`,
    '2. Merge useful snapshot learnings into the local memory files while preserving valid local-specific context unless the snapshot clearly supersedes it.',
    `3. Do not modify the snapshot directory. Only update files inside ${localMemoryDir}.`,
    `4. When the merge is complete, write ${syncedMetadataPath} with this exact JSON:`,
    syncedMetadata,
    '5. After that, continue with the user request.',
  ].join('\n')
}

export function SnapshotUpdateDialog({
  agentType,
  scope,
  snapshotTimestamp,
  onComplete,
  onCancel,
}: Props): React.ReactNode {
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isApplying, setIsApplying] = useState(false)

  const snapshotDir = useMemo(
    () => getSnapshotDirForAgent(agentType),
    [agentType],
  )
  const localMemoryDir = useMemo(
    () => getAgentMemoryDir(agentType, scope),
    [agentType, scope],
  )
  const scopeDisplay = useMemo(() => getMemoryScopeDisplay(scope), [scope])

  const runKeepAction = useCallback(
    async (finish: () => void) => {
      if (isApplying) {
        return
      }

      setIsApplying(true)
      setErrorMessage(null)

      try {
        await markSnapshotSynced(agentType, scope, snapshotTimestamp)
        finish()
      } catch (error) {
        setErrorMessage(`Failed to keep current memory: ${formatError(error)}`)
        setIsApplying(false)
      }
    },
    [agentType, isApplying, scope, snapshotTimestamp],
  )

  const handleReplace = useCallback(async () => {
    if (isApplying) {
      return
    }

    setIsApplying(true)
    setErrorMessage(null)

    try {
      await replaceFromSnapshot(agentType, scope, snapshotTimestamp)
      onComplete('replace')
    } catch (error) {
      setErrorMessage(`Failed to replace memory: ${formatError(error)}`)
      setIsApplying(false)
    }
  }, [agentType, isApplying, onComplete, scope, snapshotTimestamp])

  const handleSelect = useCallback(
    (choice: SnapshotChoice) => {
      switch (choice) {
        case 'merge':
          onComplete('merge')
          return
        case 'replace':
          void handleReplace()
          return
        case 'keep':
          void runKeepAction(() => onComplete('keep'))
          return
      }
    },
    [handleReplace, onComplete, runKeepAction],
  )

  const handleCancel = useCallback(() => {
    void runKeepAction(onCancel)
  }, [onCancel, runKeepAction])

  const options: OptionWithDescription<SnapshotChoice>[] = useMemo(
    () => [
      {
        label: 'Merge snapshot into current memory',
        value: 'merge',
        description:
          'Continue into the agent with merge instructions so it can reconcile snapshot and local memory before starting work.',
      },
      {
        label: 'Replace current memory with snapshot',
        value: 'replace',
        description:
          'Overwrite the current markdown memory files with the snapshot now.',
      },
      {
        label: 'Keep current memory',
        value: 'keep',
        description:
          'Ignore this snapshot and mark it handled until a newer snapshot appears.',
      },
    ],
    [],
  )

  return (
    <Dialog
      title="Agent memory snapshot update"
      subtitle={`A newer project snapshot is available for ${agentType}.`}
      onCancel={handleCancel}
      color="permission"
      isCancelActive={!isApplying}
    >
      <Box flexDirection="column" gap={1}>
        {errorMessage ? <Text color="error">{errorMessage}</Text> : null}

        <Box flexDirection="column">
          <Text>Memory scope: {scopeDisplay}</Text>
          <Text dimColor>Snapshot updated at: {snapshotTimestamp}</Text>
          <Text dimColor>Snapshot source: {snapshotDir}</Text>
          <Text dimColor>Local memory: {localMemoryDir}</Text>
        </Box>

        {isApplying ? (
          <Box>
            <Spinner />
            <Text> Applying memory update...</Text>
          </Box>
        ) : (
          <Select
            defaultFocusValue="merge"
            options={options}
            onChange={handleSelect}
          />
        )}
      </Box>
    </Dialog>
  )
}
