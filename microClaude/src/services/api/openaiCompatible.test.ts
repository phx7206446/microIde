import { describe, expect, test } from 'bun:test'
import type { BetaToolUnion } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { getOpenAICompatibleClient } from './openaiCompatible.js'

const toolSchema = {
  type: 'object',
  properties: {
    answers: {
      type: 'object',
      propertyNames: { type: 'string' },
      additionalProperties: { type: 'string' },
    },
    message: {
      anyOf: [
        { type: 'string' },
        {
          oneOf: [
            {
              type: 'object',
              properties: {
                type: { const: 'shutdown_request' },
              },
            },
          ],
        },
      ],
    },
  },
} as const

const testTool: BetaToolUnion = {
  name: 'TestTool',
  description: 'test tool schema passthrough',
  input_schema: toolSchema,
}

async function captureToolParameters(model: string): Promise<Record<string, unknown>> {
  let requestBody: Record<string, unknown> | undefined
  const client = getOpenAICompatibleClient({
    apiKey: 'test-key',
    baseURL: 'https://example.com/v1',
    defaultHeaders: {},
    timeout: 5_000,
    fetch: async (_url, init) => {
      requestBody = JSON.parse(String(init?.body))
      return new Response(
        JSON.stringify({
          id: 'chatcmpl_test',
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: 'ok',
              },
            },
          ],
          usage: {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      )
    },
  })

  await client.beta.messages.create({
    model,
    max_tokens: 16,
    stream: false,
    messages: [{ role: 'user', content: 'hello' }],
    tools: [testTool],
  })

  const tools = requestBody?.tools
  expect(Array.isArray(tools)).toBe(true)
  return (tools as Array<{ function: { parameters: Record<string, unknown> } }>)[0]!
    .function.parameters
}

describe('getOpenAICompatibleClient Gemini tool schema compatibility', () => {
  test('sanitizes unsupported schema keywords only for Gemini models', async () => {
    const parameters = await captureToolParameters('gemini-3.1-pro-preview')
    const answers = (parameters.properties as Record<string, unknown>).answers as Record<
      string,
      unknown
    >
    const message = (parameters.properties as Record<string, unknown>).message as Record<
      string,
      unknown
    >
    const structured = ((message.anyOf as unknown[])[1] as Record<string, unknown>)
      .oneOf as Array<Record<string, unknown>>
    const typeProperty = (
      (structured[0]!.properties as Record<string, unknown>).type as Record<
        string,
        unknown
      >
    )

    expect('propertyNames' in answers).toBe(false)
    expect('const' in typeProperty).toBe(false)
    expect(typeProperty.enum).toEqual(['shutdown_request'])

    expect(toolSchema.properties.answers.propertyNames).toEqual({ type: 'string' })
    expect(toolSchema.properties.message.anyOf[1]!.oneOf[0]!.properties.type).toEqual({
      const: 'shutdown_request',
    })
  })

  test('preserves schema for non-Gemini models', async () => {
    const parameters = await captureToolParameters('non-gemini-test-model')
    const answers = (parameters.properties as Record<string, unknown>).answers as Record<
      string,
      unknown
    >
    const message = (parameters.properties as Record<string, unknown>).message as Record<
      string,
      unknown
    >
    const structured = ((message.anyOf as unknown[])[1] as Record<string, unknown>)
      .oneOf as Array<Record<string, unknown>>
    const typeProperty = (
      (structured[0]!.properties as Record<string, unknown>).type as Record<
        string,
        unknown
      >
    )

    expect(answers.propertyNames).toEqual({ type: 'string' })
    expect(typeProperty.const).toBe('shutdown_request')
    expect('enum' in typeProperty).toBe(false)
  })
})
