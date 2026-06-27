import type { Command } from '../../commands.js'
import { areWorkflowsDisabled } from '../../utils/workflowSettings.js'

const workflows = {
  type: 'local-jsx',
  name: 'workflows',
  description: 'Manage workflow runs',
  isEnabled: () => !areWorkflowsDisabled(),
  load: () => import('./workflows.js'),
} satisfies Command

export default workflows
