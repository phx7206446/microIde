import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { executeNotificationHooks } from '../../utils/hooks.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getGlobalConfig } from '../../utils/config.js'

const TOOL_NAME = 'push_notification'
const MAX_MESSAGE_LENGTH = 500

const inputSchema = lazySchema(() =>
  z.strictObject({
    message: z
      .string()
      .describe('The notification message Claude should push to the user.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    status: z.literal('sent'),
    deliveryMethod: z.enum(['os', 'hook']),
    message: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

type Output = z.infer<OutputSchema>

function normalizeMessage(message: string): string {
  return message.trim()
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text
  }
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`
}

const PROMPT = `Send a proactive push notification to the user.

Use this only when Claude should actively notify the user outside the normal transcript flow.

Important:
- This tool is gated by the user's push-notification setting.
- Keep the message short, concrete, and immediately actionable.
- Do not use this for routine progress updates that can stay in the conversation.`

export const PushNotificationTool = buildTool({
  name: TOOL_NAME,
  userFacingName() {
    return 'Push Notification'
  },
  searchHint: 'notify the user proactively',
  maxResultSizeChars: 2_000,
  strict: true,
  isConcurrencySafe() {
    return true
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  async description({ message }) {
    return `Send a push notification: ${truncate(normalizeMessage(message), MAX_MESSAGE_LENGTH)}`
  },
  async prompt() {
    return PROMPT
  },
  toAutoClassifierInput(input) {
    return normalizeMessage(input.message)
  },
  getToolUseSummary(input) {
    if (!input?.message) {
      return null
    }
    return truncate(normalizeMessage(input.message), 120)
  },
  getActivityDescription(input) {
    if (!input?.message) {
      return 'Sending push notification'
    }
    return `Sending push notification: ${truncate(
      normalizeMessage(input.message),
      120,
    )}`
  },
  renderToolUseMessage() {
    return null
  },
  async validateInput(input) {
    const message = normalizeMessage(input.message)
    if (message === '') {
      return {
        result: false,
        message: 'Notification message is required',
        errorCode: 1,
      }
    }

    return { result: true }
  },
  async checkPermissions(input) {
    const message = normalizeMessage(input.message)
    if (getGlobalConfig().agentPushNotifEnabled !== true) {
      return {
        behavior: 'deny',
        message:
          'push_notification is disabled by settings. Enable agent push notifications in /config before using this tool.',
        decisionReason: {
          type: 'other',
          reason: 'agentPushNotifEnabled is disabled',
        },
      }
    }

    return {
      behavior: 'allow',
      updatedInput: {
        message,
      },
    }
  },
  async call(input, context) {
    const message = normalizeMessage(input.message)

    if (getGlobalConfig().agentPushNotifEnabled !== true) {
      throw new Error(
        'push_notification is disabled by settings for this session',
      )
    }

    if (context.sendOSNotification) {
      context.sendOSNotification({
        message,
        notificationType: 'agent_push',
      })
      return {
        data: {
          status: 'sent',
          deliveryMethod: 'os',
          message,
        },
      }
    }

    await executeNotificationHooks({
      message,
      notificationType: 'agent_push',
    })

    return {
      data: {
        status: 'sent',
        deliveryMethod: 'hook',
        message,
      },
    }
  },
  mapToolResultToToolResultBlockParam(data, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content:
        data.deliveryMethod === 'os'
          ? 'Sent push notification.'
          : 'Sent push notification through notification hooks.',
    }
  },
} satisfies ToolDef<InputSchema, Output>)
