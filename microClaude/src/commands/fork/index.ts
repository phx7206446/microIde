import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { Command } from '../../commands.js'
import { buildChildMessage, isForkSubagentEnabled } from '../../tools/AgentTool/forkSubagent.js'
import { MalformedCommandError } from '../../utils/errors.js'

const fork = {
  type: 'prompt',
  name: 'fork',
  description: 'Run a scoped directive in a forked worker',
  argumentHint: '<directive>',
  progressMessage: 'starting fork',
  contentLength: 0,
  source: 'builtin',
  context: 'fork',
  disableNonInteractive: true,
  isEnabled: () => isForkSubagentEnabled(),
  async getPromptForCommand(args): Promise<ContentBlockParam[]> {
    const directive = args.trim()
    if (!directive) {
      throw new MalformedCommandError('Usage: /fork <directive>')
    }

    return [
      {
        type: 'text',
        text: buildChildMessage(directive),
      },
    ]
  },
} satisfies Command

export default fork
