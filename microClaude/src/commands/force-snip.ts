import type { Command } from '../commands.js'
import type { LocalCommandCall } from '../types/command.js'
import { getMessagesAfterCompactBoundary } from '../utils/messages.js'
import {
  createSnipBoundaryMessage,
  isSnipRuntimeEnabled,
  listSnippableMessageIds,
  planSnipFromMessageIds,
} from '../services/compact/snipCompact.js'

function parseArgs(args: string): string[] {
  return [...new Set(args.split(/[\s,]+/).map(part => part.trim()).filter(Boolean))]
}

const call: LocalCommandCall = async (_args, context) => {
  if (!context.appendSystemMessage) {
    return {
      type: 'text',
      value: '/force-snip is only available in interactive sessions.',
    }
  }

  const activeMessages = getMessagesAfterCompactBoundary(context.messages)
  const requestedIds =
    parseArgs(_args).length > 0
      ? parseArgs(_args)
      : listSnippableMessageIds(activeMessages)

  if (requestedIds.length === 0) {
    return {
      type: 'text',
      value: 'No snippable turns found.',
    }
  }

  const plan = planSnipFromMessageIds(
    activeMessages,
    requestedIds,
    'Forced via /force-snip',
  )

  if (plan.removedUuids.length === 0) {
    return {
      type: 'text',
      value:
        plan.skippedMessageIds.length > 0
          ? `No turns were snipped. Skipped IDs: ${plan.skippedMessageIds.join(', ')}.`
          : 'No turns were snipped.',
    }
  }

  context.appendSystemMessage(createSnipBoundaryMessage(plan))

  return {
    type: 'text',
    value: `Trimmed ${plan.removedMessageIds.length} turn${plan.removedMessageIds.length === 1 ? '' : 's'} (${plan.removedCount} messages, ~${Math.round(plan.tokensFreed)} tokens).`,
  }
}

const forceSnip = {
  type: 'local',
  name: 'force-snip',
  description:
    'Immediately trim older conversation turns from the active context',
  isEnabled: () => isSnipRuntimeEnabled(),
  supportsNonInteractive: false,
  argumentHint: '[message-id ...]',
  load: () => Promise.resolve({ call }),
} satisfies Command

export default forceSnip
