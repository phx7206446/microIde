import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import { isBriefEnabled } from '../BriefTool/BriefTool.js'
import type { ProgressMessage } from '../../types/message.js'
import type { ValidationResult } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { plural } from '../../utils/stringUtils.js'
import { resolveAttachments, validateAttachmentPaths } from '../BriefTool/attachments.js'
import {
  renderToolResultMessage as renderBriefToolResultMessage,
  renderToolUseMessage,
} from '../BriefTool/UI.js'
import {
  DESCRIPTION,
  SEND_USER_FILE_TOOL_NAME,
  SEND_USER_FILE_TOOL_PROMPT,
} from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    files: z
      .array(z.string())
      .min(1)
      .describe(
        'File paths (absolute or relative to cwd) to deliver to the user.',
      ),
    message: z
      .string()
      .optional()
      .describe('Optional short message to show alongside the files.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    message: z.string().optional(),
    attachments: z
      .array(
        z.object({
          path: z.string(),
          size: z.number(),
          isImage: z.boolean(),
          file_uuid: z.string().optional(),
        }),
      )
      .describe('Resolved attachment metadata'),
    sentAt: z
      .string()
      .optional()
      .describe('ISO timestamp captured at tool execution time.'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
type Output = z.infer<OutputSchema>

function renderToolResultMessage(
  output: Output,
  progressMessages: ProgressMessage[],
  options?: {
    isTranscriptMode?: boolean
    isBriefOnly?: boolean
  },
) {
  return renderBriefToolResultMessage(
    {
      message: output.message ?? '',
      attachments: output.attachments,
      sentAt: output.sentAt,
    },
    progressMessages,
    options,
  )
}

export const SendUserFileTool = buildTool({
  name: SEND_USER_FILE_TOOL_NAME,
  searchHint: 'send files to the user-visible channel',
  maxResultSizeChars: 100_000,
  userFacingName() {
    return ''
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    return feature('KAIROS') ? isBriefEnabled() : false
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return `${input.files.join(' ')}${input.message ? `\n${input.message}` : ''}`
  },
  async validateInput({ files }): Promise<ValidationResult> {
    return validateAttachmentPaths(files)
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return SEND_USER_FILE_TOOL_PROMPT
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const n = output.attachments.length
    const suffix = ` (${n} ${plural(n, 'file')} included)`
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `Files delivered to user.${suffix}`,
    }
  },
  renderToolUseMessage,
  renderToolResultMessage,
  async call({ files, message }, context) {
    const sentAt = new Date().toISOString()
    const appState = context.getAppState()
    const attachments = await resolveAttachments(files, {
      replBridgeEnabled: appState.replBridgeEnabled,
      signal: context.abortController.signal,
    })
    return {
      data: {
        message,
        attachments,
        sentAt,
      },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
