import type { Command } from '../../commands.js'

const assistant = {
  type: 'local-jsx',
  name: 'assistant',
  description: 'Install assistant support for the current project',
  immediate: true,
  load: () => import('./assistant.js'),
} satisfies Command

export default assistant
