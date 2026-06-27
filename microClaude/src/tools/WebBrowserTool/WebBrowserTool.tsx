import React from 'react'
import { z } from 'zod/v4'
import { Text } from '../../ink.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { openBrowser } from '../../utils/browser.js'
import { lazySchema } from '../../utils/lazySchema.js'

const WEB_BROWSER_TOOL_NAME = 'WebBrowser'
const DESCRIPTION =
  'Open, track, or clear a browser session for local development URLs.'

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z.enum(['open', 'status', 'close']).describe('Browser action to perform'),
    url: z
      .string()
      .optional()
      .describe('Required when action is "open"'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    active: z.boolean(),
    url: z.string().optional(),
    message: z.string(),
    embedded: z.boolean(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
type Output = z.infer<OutputSchema>

function hasEmbeddedBrowser(): boolean {
  const bun = (globalThis as typeof globalThis & { Bun?: { WebView?: unknown } }).Bun
  return typeof bun !== 'undefined' && 'WebView' in bun
}

function validateHttpUrl(url: string): void {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}`)
  }
}

export const WebBrowserTool = buildTool({
  name: WEB_BROWSER_TOOL_NAME,
  searchHint: 'open a local dev URL in a browser',
  maxResultSizeChars: 10_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isReadOnly(input) {
    return input.action !== 'open'
  },
  isConcurrencySafe() {
    return true
  },
  async description(input) {
    return input.action === 'open'
      ? `${DESCRIPTION} (${input.url ?? 'missing URL'})`
      : DESCRIPTION
  },
  async prompt() {
    return 'Use this to open a browser for a local development URL, inspect the tracked URL, or clear the tracked browser state.'
  },
  renderToolUseMessage(input) {
    return <Text>{`${WEB_BROWSER_TOOL_NAME}: ${input.action ?? 'status'}`}</Text>
  },
  renderToolResultMessage(output) {
    return <Text dimColor>{output.message}</Text>
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: output.message,
    }
  },
  async call(input, context) {
    const embedded = hasEmbeddedBrowser()
    const currentState = context.getAppState()

    if (input.action === 'status') {
      return {
        data: {
          active: currentState.bagelActive === true,
          url: currentState.bagelUrl,
          embedded,
          message:
            currentState.bagelActive && currentState.bagelUrl
              ? `Tracked browser URL: ${currentState.bagelUrl}`
              : 'No tracked browser session.',
        },
      }
    }

    if (input.action === 'close') {
      context.setAppState(prev => ({
        ...prev,
        bagelActive: false,
        bagelPanelVisible: false,
        bagelUrl: undefined,
      }))

      return {
        data: {
          active: false,
          url: undefined,
          embedded,
          message: embedded
            ? 'Cleared tracked browser session.'
            : 'Cleared tracked browser session. Any external browser window remains open.',
        },
      }
    }

    if (!input.url) {
      throw new Error('url is required when action is "open"')
    }

    validateHttpUrl(input.url)

    const opened = await openBrowser(input.url)
    if (!opened) {
      throw new Error(`Failed to open browser for ${input.url}`)
    }

    context.setAppState(prev => ({
      ...prev,
      bagelActive: true,
      bagelPanelVisible: true,
      bagelUrl: input.url,
    }))

    return {
      data: {
        active: true,
        url: input.url,
        embedded,
        message: embedded
          ? `Opened ${input.url} in the development browser.`
          : `Opened ${input.url} in the system browser and tracked it in the REPL.`,
      },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
