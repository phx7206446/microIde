import * as React from 'react'
import { useEffect, useRef } from 'react'
import { Box, Text } from '../ink.js'
import type { EffortLevel } from '../utils/effort.js'
import {
  convertEffortValueToLevel,
  getDefaultEffortForModel,
  getSupportedEffortLevels,
  toPersistableEffort,
} from '../utils/effort.js'
import { updateSettingsForSource } from '../utils/settings/settings.js'
import type { OptionWithDescription } from './CustomSelect/select.js'
import { Select } from './CustomSelect/select.js'
import { EffortIndicatorSymbol } from './EffortIndicatorSymbol.js'
import { PermissionDialog } from './permissions/PermissionDialog.js'

type EffortCalloutSelection = EffortLevel | undefined | 'dismiss'

type Props = {
  model: string
  onDone: (selection: EffortCalloutSelection) => void
}

const AUTO_DISMISS_MS = 30_000

export function EffortCallout({ model, onDone }: Props): React.ReactNode {
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  useEffect(() => {
    const timeoutId = setTimeout(
      () => onDoneRef.current('dismiss'),
      AUTO_DISMISS_MS,
    )
    return () => clearTimeout(timeoutId)
  }, [])

  const defaultEffort = getDefaultEffortForModel(model)
  const defaultLevel = defaultEffort
    ? convertEffortValueToLevel(defaultEffort)
    : 'high'
  const supportedLevels = getSupportedEffortLevels(model)
  const levels =
    supportedLevels.length > 0
      ? supportedLevels
      : (['low', 'medium', 'high'] as const satisfies readonly EffortLevel[])
  const options: OptionWithDescription<EffortLevel>[] = levels.map(level => ({
    label: <EffortOptionLabel level={level} text={formatEffortLevel(level)} />,
    value: level,
  }))

  function handleSelect(value: EffortLevel): void {
    const effortLevel = value === defaultLevel ? undefined : value
    updateSettingsForSource('userSettings', {
      effortLevel: toPersistableEffort(effortLevel),
    })
    onDoneRef.current(value)
  }

  return (
    <PermissionDialog title="Choose effort level">
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Box marginBottom={1} flexDirection="column">
          <Text>
            Effort determines how long Claude thinks before responding. Use the
            default to follow the current model.
          </Text>
        </Box>
        <Select
          options={options}
          defaultValue={defaultLevel}
          onChange={handleSelect}
          onCancel={() => onDoneRef.current('dismiss')}
        />
      </Box>
    </PermissionDialog>
  )
}

function EffortOptionLabel({
  level,
  text,
}: {
  level: EffortLevel
  text: string
}): React.ReactNode {
  return (
    <>
      <EffortIndicatorSymbol level={level} /> {text}
    </>
  )
}

function formatEffortLevel(level: EffortLevel): string {
  if (level === 'xhigh') return 'XHigh'
  return level[0]!.toUpperCase() + level.slice(1)
}

export function shouldShowEffortCallout(model: string): boolean {
  void model
  return false
}
