import React from 'react'
import { z } from 'zod/v4'
import { Box, Text } from '../../ink.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'

export const OVERFLOW_TEST_TOOL_NAME = 'OverflowTest'

const DESCRIPTION =
  'Generate an intentionally large tool result for testing persistence and overflow handling.'

const DEFAULT_CHARS = 12_000

const inputSchema = lazySchema(() =>
  z.strictObject({
    chars: z
      .number()
      .int()
      .min(100)
      .max(250_000)
      .default(DEFAULT_CHARS)
      .describe('Approximate number of characters to generate'),
    line_prefix: z
      .string()
      .trim()
      .max(80)
      .default('overflow-test')
      .describe('Prefix to repeat in the generated output'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    chars: z.number().int(),
    content: z.string(),
    preview: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
type Output = z.infer<OutputSchema>

function buildContent(chars: number, linePrefix: string): string {
  const lines: string[] = []
  let count = 0
  let lineNo = 1

  while (count < chars) {
    const line = `${linePrefix} line ${lineNo.toString().padStart(4, '0')} ${'x'.repeat(64)}`
    lines.push(line)
    count += line.length + 1
    lineNo++
  }

  return lines.join('\n')
}

export const OverflowTestTool = buildTool({
  name: OVERFLOW_TEST_TOOL_NAME,
  searchHint: 'stress large tool results',
  maxResultSizeChars: 4_000,
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
    return (
      <Text>
        Generating overflow payload (~{input.chars ?? DEFAULT_CHARS} chars)
      </Text>
    )
  },
  renderToolResultMessage(output) {
    return (
      <Box flexDirection="column">
        <Text>Generated {output.chars} chars</Text>
        <Text dimColor>{output.preview}</Text>
      </Box>
    )
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: output.content,
    }
  },
  async call(input) {
    const content = buildContent(input.chars, input.line_prefix)
    return {
      data: {
        chars: content.length,
        preview: content.slice(0, 160),
        content,
      },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
