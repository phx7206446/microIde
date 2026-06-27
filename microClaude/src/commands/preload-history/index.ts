import type { Command } from '../../commands.js'

const preloadHistory = {
  type: 'local',
  name: 'preload-history',
  description: 'Preload a fresh session with history from a JSON file',
  aliases: ['load-history', 'import-history'],
  argumentHint: '<json-file>',
  supportsNonInteractive: false,
  load: () => import('./preload-history.js'),
} satisfies Command

export default preloadHistory
