import React, { useState } from 'react'
import { basename, resolve } from 'path'
import { installAssistantProject } from '../../assistant/install.js'
import { Select } from '../../components/CustomSelect/index.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { LoadingState } from '../../components/design-system/LoadingState.js'
import { Box, Text } from '../../ink.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { getOriginalCwd } from '../../bootstrap/state.js'

type InstallPhase = 'confirm' | 'installing'

type NewInstallWizardProps = {
  defaultDir: string
  onInstalled: (dir: string) => void
  onCancel: () => void
  onError: (message: string) => void
}

export async function computeDefaultInstallDir(): Promise<string> {
  return resolve(getOriginalCwd())
}

export function NewInstallWizard({
  defaultDir,
  onInstalled,
  onCancel,
  onError,
}: NewInstallWizardProps): React.ReactNode {
  const [phase, setPhase] = useState<InstallPhase>('confirm')

  const handleInstall = async (): Promise<void> => {
    setPhase('installing')
    try {
      await installAssistantProject(defaultDir)
      onInstalled(defaultDir)
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown installation error'
      onError(message)
    }
  }

  if (phase === 'installing') {
    return (
      <LoadingState
        message="Installing assistant..."
        subtitle="Writing project-local settings, assistant prompt, and scheduled tasks."
      />
    )
  }

  return (
    <Dialog
      title="Install Assistant"
      subtitle={basename(defaultDir) || defaultDir}
      onCancel={onCancel}
    >
      <Box flexDirection="column" gap={1}>
        <Text>Install assistant support into:</Text>
        <Text color="info">{defaultDir}</Text>
        <Text dimColor>
          This writes project-local assistant settings, the assistant system
          prompt, and the built-in scheduled assistant tasks.
        </Text>
        <Text dimColor>
          Restart Claude in this directory after installation to enter
          assistant mode.
        </Text>
        <Select
          options={[
            { label: 'Install', value: 'install' },
            { label: 'Cancel', value: 'cancel' },
          ]}
          onChange={value => {
            if (value === 'install') {
              void handleInstall()
              return
            }
            onCancel()
          }}
          onCancel={onCancel}
        />
      </Box>
    </Dialog>
  )
}

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  if (args.trim().length > 0) {
    onDone('Usage: /assistant', { display: 'system' })
    return null
  }

  const defaultDir = await computeDefaultInstallDir()

  return (
    <NewInstallWizard
      defaultDir={defaultDir}
      onInstalled={dir =>
        onDone(
          `Assistant installed in ${dir}. Restart Claude in this directory to enter assistant mode.`,
          { display: 'system' },
        )
      }
      onCancel={() =>
        onDone('Assistant installation dismissed', { display: 'system' })
      }
      onError={message =>
        onDone(`Assistant installation failed: ${message}`, {
          display: 'system',
        })
      }
    />
  )
}
