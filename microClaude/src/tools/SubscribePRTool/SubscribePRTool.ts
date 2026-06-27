import { z } from 'zod/v4'
import { isReplBridgeActive } from '../../bootstrap/state.js'
import { getReplBridgeHandle } from '../../bridge/replBridgeHandle.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import type { AssistantMessage } from '../../types/message.js'
import { lazySchema } from '../../utils/lazySchema.js'

const TOOL_NAME = 'subscribe_pr_activity'
const UNSUBSCRIBE_TOOL_NAME = 'unsubscribe_pr_activity'
const REPOSITORY_PATTERN = /^[^/\s]+\/[^/\s]+$/

const inputSchema = lazySchema(() =>
  z.strictObject({
    repository: z
      .string()
      .describe('GitHub repository in owner/repo format.'),
    pr_number: z
      .number()
      .int()
      .positive()
      .describe('GitHub pull request number to subscribe to.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    success: z.literal(true),
    action: z.enum(['subscribe', 'unsubscribe']),
    repository: z.string(),
    pr_number: z.number().int().positive(),
    message: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
type Output = z.infer<OutputSchema>

const PROMPT = `Manage GitHub pull request activity delivery for the active Remote Control session.

Use subscribe_pr_activity to start receiving GitHub PR activity as user messages.
Use unsubscribe_pr_activity to stop receiving it.

Input:
- repository: GitHub repository in owner/repo format
- pr_number: pull request number

Notes:
- Remote Control must be connected and fully active.
- These subscriptions are for GitHub PR activity such as review comments and CI updates.`

function describeTarget(input: Pick<Output, 'repository' | 'pr_number'>): string {
  return `${input.repository}#${input.pr_number}`
}

function getActionFromInvocation(
  toolUseId: string | undefined,
  assistantMessage: AssistantMessage,
): Output['action'] {
  if (!toolUseId) {
    return 'subscribe'
  }

  const toolUseBlock = assistantMessage.message?.content?.find(
    block => block.type === 'tool_use' && block.id === toolUseId,
  )
  if (
    toolUseBlock &&
    toolUseBlock.type === 'tool_use' &&
    toolUseBlock.name === UNSUBSCRIBE_TOOL_NAME
  ) {
    return 'unsubscribe'
  }

  return 'subscribe'
}

function requireActiveBridge(): NonNullable<ReturnType<typeof getReplBridgeHandle>> {
  const handle = getReplBridgeHandle()
  if (!handle || !isReplBridgeActive()) {
    throw new Error(
      'Remote Control is not connected. Reconnect with /remote-control before managing PR activity subscriptions.',
    )
  }
  return handle
}

export const SubscribePRTool = buildTool({
  name: TOOL_NAME,
  aliases: [UNSUBSCRIBE_TOOL_NAME],
  maxResultSizeChars: 4_000,
  searchHint: 'manage GitHub pull request activity delivery',
  strict: true,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'PR Activity'
  },
  isEnabled() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return false
  },
  async description(input) {
    return `Manage PR activity delivery for ${describeTarget(input)}`
  },
  async prompt() {
    return PROMPT
  },
  toAutoClassifierInput(input) {
    return describeTarget(input)
  },
  getToolUseSummary(input) {
    if (!input?.repository || !input?.pr_number) {
      return null
    }
    return describeTarget({
      repository: input.repository,
      pr_number: input.pr_number,
    })
  },
  getActivityDescription(input) {
    if (!input?.repository || !input?.pr_number) {
      return 'Managing PR activity subscription'
    }
    return `Managing PR activity for ${describeTarget({
      repository: input.repository,
      pr_number: input.pr_number,
    })}`
  },
  renderToolUseMessage() {
    return null
  },
  renderToolResultMessage() {
    return null
  },
  async validateInput(input) {
    if (!REPOSITORY_PATTERN.test(input.repository.trim())) {
      return {
        result: false,
        message: 'repository must be in owner/repo format',
        errorCode: 9,
      }
    }

    if (!getReplBridgeHandle() || !isReplBridgeActive()) {
      return {
        result: false,
        message:
          'Remote Control is not connected. Reconnect with /remote-control before managing PR activity subscriptions.',
        errorCode: 9,
      }
    }

    return { result: true }
  },
  async call(input, context, _canUseTool, assistantMessage) {
    const action = getActionFromInvocation(context.toolUseId, assistantMessage)
    const handle = requireActiveBridge()
    const target = {
      repository: input.repository.trim(),
      prNumber: input.pr_number,
    }
    const result =
      action === 'unsubscribe'
        ? await handle.unsubscribePR(target)
        : await handle.subscribePR(target)

    return {
      data: {
        success: true,
        action,
        repository: result.repository,
        pr_number: result.prNumber,
        message: result.message,
      } satisfies Output,
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      type: 'tool_result',
      content: output.message,
      tool_use_id: toolUseID,
      is_error: false,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
