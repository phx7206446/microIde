import type { Command } from '../../commands.js'

const goal = {
  type: 'local-jsx',
  name: 'goal',
  description: 'Set or inspect an autonomous session goal',
  argumentHint: '[condition|clear]',
  immediate: true,
  supportsNonInteractive: true,
  load: () => import('./goal.js'),
} satisfies Command

export default goal
