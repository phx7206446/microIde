import * as React from 'react'
import { Box, Text, useTheme } from '../../ink.js'
import { type UnaryEvent, usePermissionRequestLogging } from './hooks.js'
import { PermissionDialog } from './PermissionDialog.js'
import {
  PermissionPrompt,
  type PermissionPromptOption,
} from './PermissionPrompt.js'
import type { PermissionRequestProps } from './PermissionRequest.js'
import { PermissionRuleExplanation } from './PermissionRuleExplanation.js'
import { logUnaryPermissionEvent } from './utils.js'

type OptionValue = 'yes' | 'no'

type Props = PermissionRequestProps & {
  title: string
  question: React.ReactNode
  subtitle?: React.ReactNode
  description?: React.ReactNode
  toolType?: 'tool' | 'command' | 'edit' | 'read'
  buildUpdatedInput?: (
    input: Record<string, unknown>,
  ) => Record<string, unknown>
  acceptLabel?: React.ReactNode
  rejectLabel?: React.ReactNode
}

const unaryEvent: UnaryEvent = {
  completion_type: 'tool_use_single',
  language_name: 'none',
}

function renderMaybeText(
  value: React.ReactNode,
  dimColor = false,
): React.ReactNode {
  if (value === null || value === undefined || value === false) {
    return null
  }
  if (typeof value === 'string' || typeof value === 'number') {
    return <Text dimColor={dimColor}>{value}</Text>
  }
  return value
}

export function SimpleToolPermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
  verbose,
  workerBadge,
  title,
  question,
  subtitle,
  description,
  toolType = 'tool',
  buildUpdatedInput,
  acceptLabel = 'Yes',
  rejectLabel = 'No',
}: Props): React.ReactNode {
  const [theme] = useTheme()

  usePermissionRequestLogging(toolUseConfirm, unaryEvent)

  const renderedToolUseMessage = toolUseConfirm.tool.renderToolUseMessage(
    toolUseConfirm.input as never,
    { theme, verbose },
  )

  const handleSelect = (value: OptionValue, feedback?: string) => {
    if (value === 'yes') {
      const updatedInput =
        buildUpdatedInput?.(toolUseConfirm.input as Record<string, unknown>) ??
        (toolUseConfirm.input as Record<string, unknown>)

      logUnaryPermissionEvent(
        'tool_use_single',
        toolUseConfirm,
        'accept',
        !!feedback,
      )
      toolUseConfirm.onAllow(updatedInput as never, [], feedback)
      onDone()
      return
    }

    logUnaryPermissionEvent(
      'tool_use_single',
      toolUseConfirm,
      'reject',
      !!feedback,
    )
    toolUseConfirm.onReject(feedback)
    onReject()
    onDone()
  }

  const options: PermissionPromptOption<OptionValue>[] = [
    {
      label: acceptLabel,
      value: 'yes',
      feedbackConfig: {
        type: 'accept',
      },
    },
    {
      label: rejectLabel,
      value: 'no',
      feedbackConfig: {
        type: 'reject',
      },
    },
  ]

  const content =
    renderedToolUseMessage || description ? (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        {renderMaybeText(renderedToolUseMessage)}
        {renderMaybeText(description, true)}
      </Box>
    ) : null

  return (
    <PermissionDialog
      title={title}
      subtitle={subtitle}
      workerBadge={workerBadge}
    >
      <Box flexDirection="column">
        <PermissionRuleExplanation
          permissionResult={toolUseConfirm.permissionResult}
          toolType={toolType}
        />
        {content}
        <PermissionPrompt
          options={options}
          onSelect={handleSelect}
          onCancel={() => handleSelect('no')}
          question={question}
        />
      </Box>
    </PermissionDialog>
  )
}
