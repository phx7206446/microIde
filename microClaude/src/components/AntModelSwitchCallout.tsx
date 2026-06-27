import React, { useCallback, useEffect, useMemo, useRef } from 'react'
import { Box, Text } from '../ink.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import {
  getAntModelOverrideConfig,
  resolveAntModel,
} from '../utils/model/antModels.js'
import type { OptionWithDescription } from './CustomSelect/select.js'
import { Select } from './CustomSelect/select.js'
import { PermissionDialog } from './permissions/PermissionDialog.js'

type AntModelSwitchCalloutSelection =
  | 'switch'
  | 'not-now'
  | 'dont-show-again'
  | 'acknowledge'

type Props = {
  onDone: (selection: 'switch' | 'dismiss', modelAlias?: string) => void
}

const REMIND_AFTER_MS = 24 * 60 * 60 * 1000

function getSwitchCalloutConfig() {
  if (process.env.USER_TYPE !== 'ant') {
    return null
  }
  return getAntModelOverrideConfig()?.switchCallout ?? null
}

export function shouldShowModelSwitchCallout(): boolean {
  if (process.env.USER_TYPE !== 'ant') {
    return false
  }

  const callout = getSwitchCalloutConfig()
  if (!callout?.description || !callout.version) {
    return false
  }

  if (callout.modelAlias && !resolveAntModel(callout.modelAlias)) {
    return false
  }

  const config = getGlobalConfig()
  if (config.modelSwitchCalloutVersion === callout.version) {
    return false
  }

  const lastShown = config.modelSwitchCalloutLastShown ?? 0
  if (Date.now() - lastShown < REMIND_AFTER_MS) {
    return false
  }

  return true
}

export function AntModelSwitchCallout({
  onDone,
}: Props): React.ReactNode {
  const callout = getSwitchCalloutConfig()
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  useEffect(() => {
    if (!callout) {
      return
    }
    const shownAt = Date.now()
    saveGlobalConfig(current => ({
      ...current,
      modelSwitchCalloutLastShown: Math.max(
        current.modelSwitchCalloutLastShown ?? 0,
        shownAt,
      ),
    }))
  }, [callout])

  const handleCancel = useCallback(() => {
    onDoneRef.current('dismiss')
  }, [])

  const targetModel = callout?.modelAlias
    ? resolveAntModel(callout.modelAlias)
    : undefined
  const canSwitch = Boolean(callout?.modelAlias && targetModel)

  const handleSelect = useCallback(
    (value: AntModelSwitchCalloutSelection) => {
      if (!callout) {
        onDoneRef.current('dismiss')
        return
      }

      switch (value) {
        case 'switch':
          saveGlobalConfig(current => ({
            ...current,
            modelSwitchCalloutVersion: callout.version,
            modelSwitchCalloutDismissed: false,
          }))
          onDoneRef.current('switch', callout.modelAlias)
          return
        case 'dont-show-again':
          saveGlobalConfig(current => ({
            ...current,
            modelSwitchCalloutVersion: callout.version,
            modelSwitchCalloutDismissed: true,
          }))
          onDoneRef.current('dismiss')
          return
        case 'acknowledge':
          saveGlobalConfig(current => ({
            ...current,
            modelSwitchCalloutVersion: callout.version,
            modelSwitchCalloutDismissed: false,
          }))
          onDoneRef.current('dismiss')
          return
        default:
          onDoneRef.current('dismiss')
      }
    },
    [callout],
  )

  const options = useMemo<
    OptionWithDescription<AntModelSwitchCalloutSelection>[]
  >(() => {
    if (!callout) {
      return []
    }
    if (!canSwitch || !targetModel) {
      return [
        {
          label: 'Got it',
          description: 'Keep the current model for now.',
          value: 'acknowledge',
        },
        {
          label: "Don't show again",
          description: 'Hide this notice until a new model rollout needs another prompt.',
          value: 'dont-show-again',
        },
      ]
    }
    return [
      {
        label: `Switch to ${targetModel.label}`,
        description:
          targetModel.description ??
          `Use ${targetModel.alias} for this session.`,
        value: 'switch',
      },
      {
        label: 'Not now',
        description: 'Keep the current model and remind me later.',
        value: 'not-now',
      },
      {
        label: "Don't show again",
        description: 'Hide this prompt until a later rollout changes it.',
        value: 'dont-show-again',
      },
    ]
  }, [callout, canSwitch, targetModel])

  if (!callout) {
    return null
  }

  return (
    <PermissionDialog title="Model Update">
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Box marginBottom={1}>
          <Text>{callout.description}</Text>
        </Box>
        {canSwitch && targetModel && (
          <Box marginBottom={1}>
            <Text dimColor>
              Recommended model: <Text bold>{targetModel.label}</Text>
              {targetModel.description ? ` · ${targetModel.description}` : ''}
            </Text>
          </Box>
        )}
        <Select
          options={options}
          onChange={handleSelect}
          onCancel={handleCancel}
        />
      </Box>
    </PermissionDialog>
  )
}
