import { isEnvTruthy } from './envUtils.js'
import { getInitialSettings } from './settings/settings.js'

export function areWorkflowsDisabled(): boolean {
  return (
    isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_WORKFLOWS) ||
    getInitialSettings().disableWorkflows === true
  )
}

export function isWorkflowKeywordTriggerDisabled(): boolean {
  return (
    areWorkflowsDisabled() ||
    isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_WORKFLOW_KEYWORD) ||
    getInitialSettings().disableWorkflowKeywordTrigger === true
  )
}
