import type { Command } from '../../commands.js'

const background = {
  type: 'local',
  name: 'background',
  aliases: ['bg'],
  description: 'Continue this session in Agent View background mode',
  supportsNonInteractive: true,
  load: () => import('./background.js'),
} satisfies Command

export default background
