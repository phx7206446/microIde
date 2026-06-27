import React, { useCallback, useEffect, useRef } from 'react'
import { Box, Text } from '../ink.js'
import { saveGlobalConfig } from '../utils/config.js'
import type { OptionWithDescription } from './CustomSelect/select.js'
import { Select } from './CustomSelect/select.js'
import { PermissionDialog } from './permissions/PermissionDialog.js'

type Props = {
  onDone: () => void
}

type UndercoverSelection = 'continue'

export function UndercoverAutoCallout({
  onDone,
}: Props): React.ReactNode {
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  useEffect(() => {
    saveGlobalConfig(current => {
      if (current.hasSeenUndercoverAutoNotice) {
        return current
      }
      return {
        ...current,
        hasSeenUndercoverAutoNotice: true,
      }
    })
  }, [])

  const handleDone = useCallback(() => {
    onDoneRef.current()
  }, [])

  const options: OptionWithDescription<UndercoverSelection>[] = [
    {
      label: 'Continue',
      description: 'Keep working with undercover protections enabled.',
      value: 'continue',
    },
  ]

  return (
    <PermissionDialog title="Undercover Mode Enabled">
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Box marginBottom={1} flexDirection="column">
          <Text>
            This repository does not look like an internal Anthropic repo, so
            Claude Code automatically enabled undercover mode.
          </Text>
          <Text> </Text>
          <Text>
            Commit messages, PR text, and other user-facing output will avoid
            Anthropic-internal names, model codenames, and AI attribution while
            you work here.
          </Text>
        </Box>
        <Select options={options} onChange={handleDone} onCancel={handleDone} />
      </Box>
    </PermissionDialog>
  )
}
