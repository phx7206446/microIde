import { createHash } from 'crypto'
import { readFile } from 'fs/promises'
import { resolve } from 'path'
import * as React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { getProjectRoot } from '../../bootstrap/state.js'
import { PermissionDialog } from '../../components/permissions/PermissionDialog.js'
import {
  PermissionPrompt,
  type PermissionPromptOption,
} from '../../components/permissions/PermissionPrompt.js'
import type { PermissionRequestProps } from '../../components/permissions/PermissionRequest.js'
import { PermissionRuleExplanation } from '../../components/permissions/PermissionRuleExplanation.js'
import {
  type UnaryEvent,
  usePermissionRequestLogging,
} from '../../components/permissions/hooks.js'
import { logUnaryPermissionEvent } from '../../components/permissions/utils.js'
import { Box, Text } from '../../ink.js'
import type { PermissionUpdate } from '../../utils/permissions/PermissionUpdateSchema.js'
import { getCwd } from '../../utils/cwd.js'
import { WORKFLOW_TOOL_NAME } from './constants.js'
import {
  parseWorkflowScript,
  resolveWorkflowByName,
  type WorkflowMeta,
} from './workflowScripts.js'

type WorkflowPermissionOption = 'yes' | 'yes-always' | 'raw-script' | 'no'

type ScriptInfo = {
  script?: string
  meta?: WorkflowMeta
  sourceLabel?: string
  error?: string
}

const unaryEvent: UnaryEvent = {
  completion_type: 'tool_use_single',
  language_name: 'none',
}

function getStringField(
  input: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim()
    }
  }
  return undefined
}

function normalizeWorkflowName(name: string): string {
  const trimmed = name.trim()
  return trimmed.startsWith('/') ? trimmed.slice(1) : trimmed
}

function getWorkflowIdentity(input: Record<string, unknown>): string {
  const scriptPath = getStringField(input, 'scriptPath')
  if (scriptPath) {
    return `scriptPath:${resolve(getCwd(), scriptPath)}`
  }

  const name = getStringField(input, 'name')
  if (name) {
    return normalizeWorkflowName(name)
  }

  const script = getStringField(input, 'script')
  if (script) {
    return `script:${createHash('sha256')
      .update(script)
      .digest('hex')
      .slice(0, 12)}`
  }

  return ''
}

function workflowDisplayName(
  input: Record<string, unknown>,
  scriptInfo: ScriptInfo,
): string {
  return (
    scriptInfo.meta?.name ??
    getStringField(input, 'name', 'scriptPath') ??
    'inline workflow'
  )
}

function permissionUpdateForIdentity(identity: string): PermissionUpdate {
  return {
    type: 'addRules',
    destination: 'localSettings',
    behavior: 'allow',
    rules: [
      {
        toolName: WORKFLOW_TOOL_NAME,
        ruleContent: identity,
      },
    ],
  }
}

async function loadScriptInfo(input: Record<string, unknown>): Promise<ScriptInfo> {
  const scriptPath = getStringField(input, 'scriptPath')
  if (scriptPath) {
    const absolutePath = resolve(getCwd(), scriptPath)
    try {
      const script = await readFile(absolutePath, 'utf8')
      const { meta } = parseWorkflowScript(script)
      return { script, meta, sourceLabel: absolutePath }
    } catch (error) {
      return {
        sourceLabel: absolutePath,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  const name = getStringField(input, 'name')
  if (name) {
    try {
      const workflow = await resolveWorkflowByName(
        getProjectRoot(),
        normalizeWorkflowName(name),
      )
      if (!workflow) {
        return { error: `Unknown workflow: ${normalizeWorkflowName(name)}` }
      }
      return {
        script: workflow.script,
        meta: workflow,
        sourceLabel: workflow.scriptPath ?? workflow.source,
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }

  const inlineScript = getStringField(input, 'script')
  if (inlineScript) {
    try {
      const { meta } = parseWorkflowScript(inlineScript)
      return { script: inlineScript, meta, sourceLabel: 'inline script' }
    } catch (error) {
      return {
        script: inlineScript,
        sourceLabel: 'inline script',
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  return { error: 'Workflow requires scriptPath, script, or name' }
}

function WorkflowSummary({
  input,
  scriptInfo,
}: {
  input: Record<string, unknown>
  scriptInfo: ScriptInfo
}): React.ReactNode {
  const displayName = workflowDisplayName(input, scriptInfo)
  const phases = scriptInfo.meta?.phases ?? []

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text>{`Workflow: ${displayName}`}</Text>
      {scriptInfo.meta?.description ? (
        <Text dimColor wrap="wrap">
          {scriptInfo.meta.description}
        </Text>
      ) : null}
      {scriptInfo.meta?.whenToUse ? (
        <Text dimColor wrap="wrap">
          {`When to use: ${scriptInfo.meta.whenToUse}`}
        </Text>
      ) : null}
      {scriptInfo.sourceLabel ? (
        <Text dimColor wrap="truncate-end">
          {`Source: ${scriptInfo.sourceLabel}`}
        </Text>
      ) : null}
      {phases.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>Phases</Text>
          {phases.map((phase, index) => (
            <Text key={`${index}-${phase.title}`} wrap="wrap">
              {`${index + 1}. ${phase.title || `Phase ${index + 1}`}`}
              {phase.detail ? <Text dimColor>{` - ${phase.detail}`}</Text> : null}
            </Text>
          ))}
        </Box>
      ) : null}
      {scriptInfo.error ? (
        <Text color="warning" wrap="wrap">
          {scriptInfo.error}
        </Text>
      ) : null}
    </Box>
  )
}

function RawScript({ script }: { script: string }): React.ReactNode {
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text dimColor>Raw workflow script</Text>
      <Text wrap="wrap">{script}</Text>
    </Box>
  )
}

export function WorkflowPermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
  workerBadge,
}: PermissionRequestProps): React.ReactNode {
  const input = toolUseConfirm.input as Record<string, unknown>
  const [scriptInfo, setScriptInfo] = useState<ScriptInfo>({})
  const [showRawScript, setShowRawScript] = useState(false)
  const identity = useMemo(() => getWorkflowIdentity(input), [input])

  usePermissionRequestLogging(toolUseConfirm, unaryEvent)

  useEffect(() => {
    let cancelled = false
    void loadScriptInfo(input).then(info => {
      if (!cancelled) {
        setScriptInfo(info)
      }
    })
    return () => {
      cancelled = true
    }
  }, [input])

  const handleSelect = (
    value: WorkflowPermissionOption,
    feedback?: string,
  ): void => {
    if (value === 'raw-script') {
      setShowRawScript(prev => !prev)
      return
    }

    if (value === 'yes' || value === 'yes-always') {
      const permissionUpdates =
        value === 'yes-always' && identity
          ? [permissionUpdateForIdentity(identity)]
          : []
      logUnaryPermissionEvent(
        'tool_use_single',
        toolUseConfirm,
        'accept',
        !!feedback,
      )
      toolUseConfirm.onAllow(input as never, permissionUpdates, feedback)
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

  const displayName = workflowDisplayName(input, scriptInfo)
  const options: PermissionPromptOption<WorkflowPermissionOption>[] = [
    {
      value: 'yes',
      label: 'Yes, run it.',
      feedbackConfig: { type: 'accept' },
    },
    ...(identity
      ? [
          {
            value: 'yes-always' as const,
            label: `Yes, and don't ask again for ${displayName} in this project.`,
            feedbackConfig: { type: 'accept' as const },
          },
        ]
      : []),
    ...(scriptInfo.script
      ? [
          {
            value: 'raw-script' as const,
            label: showRawScript ? 'Hide raw script.' : 'View raw script.',
          },
        ]
      : []),
    {
      value: 'no',
      label: 'No.',
      feedbackConfig: { type: 'reject' },
    },
  ]

  return (
    <PermissionDialog title="Run workflow" workerBadge={workerBadge}>
      <Box flexDirection="column">
        <PermissionRuleExplanation
          permissionResult={toolUseConfirm.permissionResult}
          toolType="tool"
        />
        <WorkflowSummary input={input} scriptInfo={scriptInfo} />
        {showRawScript && scriptInfo.script ? (
          <RawScript script={scriptInfo.script} />
        ) : null}
        <PermissionPrompt
          options={options}
          onSelect={handleSelect}
          onCancel={() => handleSelect('no')}
          question="Do you want Claude to run this workflow?"
          toolAnalyticsContext={{
            toolName: WORKFLOW_TOOL_NAME,
            isMcp: false,
          }}
        />
      </Box>
    </PermissionDialog>
  )
}
