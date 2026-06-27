import React from 'react'
import stripAnsi from 'strip-ansi'
import { z } from 'zod/v4'
import { Box, Text } from '../../ink.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getTerminalPanel } from '../../utils/terminalPanel.js'
import {
  DESCRIPTION,
  TERMINAL_CAPTURE_TOOL_NAME,
} from './prompt.js'

const DEFAULT_LINES = 200

const inputSchema = lazySchema(() =>
  z.strictObject({
    lines: z
      .number()
      .int()
      .min(1)
      .max(5000)
      .default(DEFAULT_LINES)
      .describe('How many recent lines of terminal scrollback to capture'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    available: z.boolean(),
    lines: z.number().int(),
    content: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
type Output = z.infer<OutputSchema>

function getPreview(content: string): string {
  return stripAnsi(content)
    .split('\n')
    .slice(-12)
    .join('\n')
    .trim()
}

function buildResultText(output: Output): string {
  if (!output.available) {
    return 'No active built-in terminal panel session was found.'
  }
  return output.content
}

export const TerminalCaptureTool = buildTool({
  name: TERMINAL_CAPTURE_TOOL_NAME,
  searchHint: 'inspect terminal panel scrollback',
  maxResultSizeChars: 50_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return DESCRIPTION
  },
  renderToolUseMessage(input) {
    return <Text>Capturing {input.lines ?? DEFAULT_LINES} terminal lines</Text>
  },
  renderToolResultMessage(output) {
    if (!output.available) {
      return <Text dimColor>No terminal panel session available</Text>
    }

    const preview = getPreview(output.content)
    return (
      <Box flexDirection="column">
        <Text dimColor>
          Captured {output.lines} lines from the terminal panel
        </Text>
        {preview ? <Text>{preview}</Text> : null}
      </Box>
    )
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: buildResultText(output),
    }
  },
  async call(input) {
    const captured = getTerminalPanel().captureScrollback(input.lines)
    return {
      data: {
        available: captured !== null,
        lines: input.lines,
        content: captured ?? '',
      },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
