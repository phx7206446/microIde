import * as React from 'react'
import { Box, Text } from '../../../ink.js'
import { FallbackPermissionRequest } from '../FallbackPermissionRequest.js'
import { type UnaryEvent, usePermissionRequestLogging } from '../hooks.js'
import { PermissionDialog } from '../PermissionDialog.js'
import {
  PermissionPrompt,
  type PermissionPromptOption,
} from '../PermissionPrompt.js'
import type { PermissionRequestProps } from '../PermissionRequest.js'
import { PermissionRuleExplanation } from '../PermissionRuleExplanation.js'
import { logUnaryPermissionEvent } from '../utils.js'
import {
  normalizeReviewArtifacts,
  ReviewArtifactTool,
} from '../../../tools/ReviewArtifactTool/ReviewArtifactTool.js'

const unaryEvent: UnaryEvent = {
  completion_type: 'tool_use_single',
  language_name: 'none',
}

const REJECT_VALUE = '__reject__'

function getPrompt(input: Record<string, unknown>): string {
  const prompt = input.prompt
  if (typeof prompt === 'string' && prompt.trim() !== '') {
    return prompt
  }
  return 'Which artifact should Claude inspect?'
}

function getSubtitle(
  description: string,
  artifactCount: number,
): React.ReactNode | undefined {
  if (description.trim() !== '') {
    return description
  }
  return `${artifactCount} artifact${artifactCount === 1 ? '' : 's'} available`
}

export function ReviewArtifactPermissionRequest(
  props: PermissionRequestProps,
): React.ReactNode {
  usePermissionRequestLogging(props.toolUseConfirm, unaryEvent)

  const parsed = ReviewArtifactTool.inputSchema.safeParse(
    props.toolUseConfirm.input,
  )
  if (!parsed.success) {
    return <FallbackPermissionRequest {...props} />
  }

  const artifacts = normalizeReviewArtifacts(parsed.data)
  if (artifacts.length === 0) {
    return <FallbackPermissionRequest {...props} />
  }

  const handleSelect = (value: string, feedback?: string) => {
    if (value === REJECT_VALUE) {
      logUnaryPermissionEvent(
        'tool_use_single',
        props.toolUseConfirm,
        'reject',
        !!feedback,
      )
      props.toolUseConfirm.onReject(feedback)
      props.onReject()
      props.onDone()
      return
    }

    logUnaryPermissionEvent(
      'tool_use_single',
      props.toolUseConfirm,
      'accept',
      !!feedback,
    )
    props.toolUseConfirm.onAllow(
      {
        ...parsed.data,
        selected: value,
      },
      [],
      feedback,
    )
    props.onDone()
  }

  const options: PermissionPromptOption<string>[] = [
    ...artifacts.map<PermissionPromptOption<string>>(artifact => ({
      label: (
        <Box flexDirection="column">
          <Text>{artifact.label}</Text>
          {artifact.description || artifact.url ? (
            <Text dimColor>{artifact.description ?? artifact.url}</Text>
          ) : null}
        </Box>
      ),
      value: artifact.key,
      feedbackConfig: {
        type: 'accept' as const,
        placeholder: 'tell Claude what to focus on in this artifact',
      },
    })),
    {
      label: 'No',
      value: REJECT_VALUE,
      feedbackConfig: {
        type: 'reject' as const,
      },
    },
  ]

  return (
    <PermissionDialog
      title="Review artifact"
      subtitle={getSubtitle(
        props.toolUseConfirm.description,
        artifacts.length,
      )}
      workerBadge={props.workerBadge}
    >
      <Box flexDirection="column">
        <PermissionRuleExplanation
          permissionResult={props.toolUseConfirm.permissionResult}
          toolType="tool"
        />
        <PermissionPrompt
          options={options}
          onSelect={handleSelect}
          onCancel={() => handleSelect(REJECT_VALUE)}
          question={getPrompt(parsed.data)}
        />
      </Box>
    </PermissionDialog>
  )
}
