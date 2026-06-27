import type Anthropic from '@anthropic-ai/sdk'
import type { ClientOptions } from '@anthropic-ai/sdk'
import { APIPromise } from '@anthropic-ai/sdk/api-promise'
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from '@anthropic-ai/sdk/error'
import { Stream } from '@anthropic-ai/sdk/streaming'
import { randomUUID } from 'crypto'
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaJSONOutputFormat,
  BetaMessage,
  BetaMessageParam,
  BetaMessageStreamParams,
  BetaRawMessageStreamEvent,
  BetaRequestDocumentBlock,
  BetaStopReason,
  BetaToolChoiceAuto,
  BetaToolChoiceTool,
  BetaToolResultBlockParam,
  BetaToolUnion,
  BetaUsage,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import {
  getOpenAICompatibleApiKey,
  getOpenAICompatibleBaseURL,
  getOpenAICompatibleParallelToolCalls,
  getOpenAICompatibleStreamRequired,
} from 'src/utils/openaiCompatible.js'

type OpenAICompatibleMessageParams = BetaMessageStreamParams & {
  output_format?: BetaJSONOutputFormat | null
}

type OpenAICompatibleCountTokensParams = {
  betas?: string[]
  messages: BetaMessageParam[]
  model: string
  output_config?: OpenAICompatibleMessageParams['output_config']
  output_format?: BetaJSONOutputFormat | null
  stop_sequences?: string[]
  system?: OpenAICompatibleMessageParams['system']
  temperature?: number
  thinking?: OpenAICompatibleMessageParams['thinking']
  tool_choice?: OpenAICompatibleMessageParams['tool_choice']
  tools?: BetaToolUnion[]
}

type OpenAICompatibleRequestOptions = {
  headers?: HeadersInit
  signal?: AbortSignal
}

type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

type OpenAIChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | OpenAIContentPart[] | null
  tool_call_id?: string
  tool_calls?: OpenAIToolCall[]
}

type OpenAITool = {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
    strict?: boolean
  }
}

type OpenAIToolCall = {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

type OpenAIToolCallDelta = {
  index?: number
  id?: string
  function?: { name?: string; arguments?: string }
}

type OpenAIChoice = {
  finish_reason?: string | null
  message?: {
    content?: string | Array<{ type?: string; text?: string }> | null
    tool_calls?: OpenAIToolCall[]
  }
}

type OpenAIStreamChoice = {
  finish_reason?: string | null
  delta?: { content?: string | null; tool_calls?: OpenAIToolCallDelta[] }
}

type OpenAIUsage = Record<string, unknown> & {
  completion_tokens?: number
  prompt_tokens?: number
  prompt_tokens_details?: Record<string, unknown>
  service_tier?: string
  speed?: string
  total_tokens?: number
}

type OpenAIChatCompletionResponse = {
  choices?: OpenAIChoice[]
  id?: string
  model?: string
  usage?: OpenAIUsage
}

type OpenAIChatCompletionChunk = {
  choices?: OpenAIStreamChoice[]
  error?: Record<string, unknown>
  id?: string
  model?: string
  usage?: OpenAIUsage
}

type OpenAICompatibleClientConfig = {
  apiKey: string | null
  allowMissingApiKey?: boolean
  baseURL: string
  defaultHeaders: Record<string, string>
  modelInfos?: OpenAICompatibleModelInfo[]
  timeout: number
  fetch?: ClientOptions['fetch']
  fetchOptions?: Record<string, unknown>
}

type OpenAICompatibleModelInfo = {
  id: string
  max_input_tokens?: number | null
  max_tokens?: number | null
}

type ToolStreamState = {
  arguments: string
  contentIndex: number
  id: string
  lastUpdatedOrder: number
  name: string
  sentArgumentsLength: number
  started: boolean
}

type AggregatedStreamContentBlock =
  | { type: 'text'; text: string }
  | { id: string; inputJSON: string; name: string; type: 'tool_use' }

const THINK_OPEN_TAG = '<think>'
const THINK_CLOSE_TAG = '</think>'

const OPENAI_REQUEST_OMIT_KEYS = new Set([
  'betas',
  'container',
  'context_management',
  'max_tokens',
  'mcp_servers',
  'messages',
  'metadata',
  'model',
  'output_config',
  'output_format',
  'service_tier',
  'stop_sequences',
  'stream',
  'system',
  'temperature',
  'thinking',
  'tool_choice',
  'tools',
])

const OPENAI_REQUEST_OMIT_EXTRA_KEYS = new Set([
  'anthropic_beta',
  'anthropic_internal',
  'anti_distillation',
])

export function getOpenAICompatibleClient({
  apiKey,
  allowMissingApiKey,
  baseURL,
  defaultHeaders,
  modelInfos,
  timeout,
  fetch,
  fetchOptions,
}: {
  apiKey?: string | null
  allowMissingApiKey?: boolean
  baseURL?: string
  defaultHeaders: Record<string, string>
  modelInfos?: OpenAICompatibleModelInfo[]
  timeout: number
  fetch?: ClientOptions['fetch']
  fetchOptions?: Record<string, unknown>
}): Anthropic {
  const resolvedConfig: OpenAICompatibleClientConfig = {
    apiKey: apiKey ?? getOpenAICompatibleApiKey(),
    allowMissingApiKey,
    baseURL: normalizeBaseURL(baseURL ?? getOpenAICompatibleBaseURL()),
    defaultHeaders,
    modelInfos,
    timeout,
    fetch,
    fetchOptions,
  }

  if (
    !resolvedConfig.allowMissingApiKey &&
    !resolvedConfig.apiKey &&
    !new Headers(resolvedConfig.defaultHeaders).has('Authorization')
  ) {
    throw new Error(
      'OPENAI_API_KEY is required when CLAUDE_CODE_USE_OPENAI_COMPATIBLE is enabled',
    )
  }

  const client = {
    beta: {
      messages: {
        create(
          params: OpenAICompatibleMessageParams,
          options?: OpenAICompatibleRequestOptions,
        ) {
          return createMessagePromise(resolvedConfig, params, options)
        },
        countTokens(
          params: OpenAICompatibleCountTokensParams,
          options?: OpenAICompatibleRequestOptions,
        ) {
          return createCountTokensPromise(resolvedConfig, params, options)
        },
      },
    },
    models: {
      async *list() {
        for (const modelInfo of getSyntheticModelInfos(
          resolvedConfig.modelInfos,
        )) {
          yield modelInfo
        }
      },
    },
  }

  return client as unknown as Anthropic
}

function createMessagePromise(
  config: OpenAICompatibleClientConfig,
  params: OpenAICompatibleMessageParams,
  options?: OpenAICompatibleRequestOptions,
): APIPromise<BetaMessage | Stream<BetaRawMessageStreamEvent>> {
  const usesStreamingTransport = shouldUseStreamingTransport(
    params.model,
    params.stream,
  )
  const responsePromise = performOpenAICompatibleRequest(
    config,
    params,
    options,
    usesStreamingTransport,
  )

  return new APIPromise(
    {} as never,
    responsePromise as never,
    async (_client, props) => {
      if (params.stream) {
        return createOpenAICompatibleStream(
          props.response,
          props.controller,
          params.model,
        ) as never
      }

      if (usesStreamingTransport) {
        return attachRequestId(
          await collectOpenAICompatibleStreamMessage(
            props.response,
            props.controller,
            params.model,
          ),
          props.response.headers.get('request-id'),
        ) as never
      }

      const payload =
        (await props.response.clone().json()) as OpenAIChatCompletionResponse
      return attachRequestId(
        mapOpenAIResponseToBetaMessage(payload, params.model, props.response),
        props.response.headers.get('request-id'),
      ) as never
    },
  ) as APIPromise<BetaMessage | Stream<BetaRawMessageStreamEvent>>
}

function createCountTokensPromise(
  config: OpenAICompatibleClientConfig,
  params: OpenAICompatibleCountTokensParams,
  options?: OpenAICompatibleRequestOptions,
): APIPromise<{ input_tokens: number }> {
  const usesStreamingTransport = shouldUseStreamingTransport(params.model, false)
  const responsePromise = performOpenAICompatibleRequest(
    config,
    {
      ...params,
      max_tokens: 1,
      stream: false,
    } as OpenAICompatibleMessageParams,
    options,
    usesStreamingTransport,
  )

  return new APIPromise(
    {} as never,
    responsePromise as never,
    async (_client, props) => {
      if (usesStreamingTransport) {
        const message = await collectOpenAICompatibleStreamMessage(
          props.response,
          props.controller,
          params.model,
        )
        return attachRequestId(
          { input_tokens: message.usage.input_tokens },
          props.response.headers.get('request-id'),
        ) as never
      }

      const payload =
        (await props.response.clone().json()) as OpenAIChatCompletionResponse
      const inputTokens = getPromptTokensFromUsage(payload.usage)
      if (inputTokens === null) {
        throw new APIConnectionError({
          message:
            'OpenAI compatible provider did not return prompt token usage.',
        })
      }

      return attachRequestId(
        { input_tokens: inputTokens },
        props.response.headers.get('request-id'),
      ) as never
    },
  ) as APIPromise<{ input_tokens: number }>
}

async function performOpenAICompatibleRequest(
  config: OpenAICompatibleClientConfig,
  params: OpenAICompatibleMessageParams,
  options?: OpenAICompatibleRequestOptions,
  usesStreamingTransport = Boolean(params.stream),
) {
  const controller = new AbortController()
  const startTime = Date.now()
  let didTimeout = false
  const removeAbortListener = forwardAbortSignal(options?.signal, controller)
  const timeoutId = setTimeout(() => {
    didTimeout = true
    controller.abort()
  }, config.timeout)

  try {
    const headers = new Headers(config.defaultHeaders)
    if (config.apiKey && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${config.apiKey}`)
    }
    headers.set(
      'Accept',
      usesStreamingTransport ? 'text/event-stream' : 'application/json',
    )
    headers.set('Content-Type', 'application/json')

    if (options?.headers) {
      const requestHeaders = new Headers(options.headers)
      requestHeaders.forEach((value, key) => {
        headers.set(key, value)
      })
    }

    const fetchImpl = (config.fetch ?? globalThis.fetch) as typeof fetch
    const response = await fetchImpl(getChatCompletionsURL(config.baseURL), {
      method: 'POST',
      headers,
      body: JSON.stringify(buildOpenAIRequestBody(params, usesStreamingTransport)),
      signal: controller.signal,
      ...(config.fetchOptions ?? {}),
    } as RequestInit)

    clearTimeout(timeoutId)
    removeAbortListener()

    const normalizedResponse = normalizeResponseHeaders(response)
    if (!normalizedResponse.ok) {
      throw await createAPIError(normalizedResponse)
    }

    return {
      controller,
      options: { stream: usesStreamingTransport } as never,
      requestLogID: randomUUID(),
      response: normalizedResponse,
      retryOfRequestLogID: undefined,
      startTime,
    }
  } catch (error) {
    clearTimeout(timeoutId)
    removeAbortListener()

    if (error instanceof APIError) {
      throw error
    }
    if (didTimeout) {
      throw new APIConnectionTimeoutError()
    }
    if (options?.signal?.aborted) {
      throw new APIUserAbortError()
    }
    if (
      error instanceof Error &&
      error.name === 'AbortError' &&
      controller.signal.aborted
    ) {
      throw new APIUserAbortError()
    }
    throw new APIConnectionError({
      cause: error instanceof Error ? error : undefined,
      message: error instanceof Error ? error.message : 'Connection error.',
    })
  }
}

function buildOpenAIRequestBody(
  params: OpenAICompatibleMessageParams,
  usesStreamingTransport = Boolean(params.stream),
): Record<string, unknown> {
  const tools = convertTools(params.tools, params.model)
  const toolChoice = convertToolChoice(params.tool_choice)
  const parallelToolCalls = resolveParallelToolCalls(
    params.model,
    tools.length > 0,
    toolChoice.disableParallelToolUse,
  )
  const responseFormat = buildResponseFormat(
    params.output_config?.format ?? params.output_format,
    tools,
  )

  return {
    model: params.model,
    messages: convertAnthropicMessages(params.system, params.messages),
    max_tokens: params.max_tokens,
    ...(params.temperature !== undefined
      ? { temperature: params.temperature }
      : {}),
    ...(params.stop_sequences?.length ? { stop: params.stop_sequences } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(toolChoice.value !== undefined ? { tool_choice: toolChoice.value } : {}),
    ...(parallelToolCalls !== undefined
      ? { parallel_tool_calls: parallelToolCalls }
      : {}),
    ...(responseFormat ? { response_format: responseFormat } : {}),
    ...(params.output_config?.effort
      ? { reasoning_effort: normalizeReasoningEffort(params.output_config.effort) }
      : {}),
    ...(usesStreamingTransport
      ? { stream: true, stream_options: { include_usage: true } }
      : {}),
    ...getPassthroughRequestFields(
      params as unknown as Record<string, unknown>,
    ),
  }
}

function shouldUseStreamingTransport(
  model: string,
  stream: boolean | null | undefined,
): boolean {
  if (stream) {
    return true
  }

  // Some OpenAI-compatible gateways only accept chat completions with
  // stream=true. Keep Claude's non-streaming fallback semantics at the caller
  // boundary, but fulfill them here by aggregating the SSE response back into
  // a BetaMessage.
  return getOpenAICompatibleStreamRequired(model)
}

function convertAnthropicMessages(
  system: OpenAICompatibleMessageParams['system'],
  messages: BetaMessageParam[],
): OpenAIChatMessage[] {
  const openaiMessages: OpenAIChatMessage[] = []
  const systemText = flattenSystemPrompt(system)
  if (systemText) {
    openaiMessages.push({ role: 'system', content: systemText })
  }

  for (const message of messages) {
    if (message.role === 'assistant') {
      appendAssistantMessage(openaiMessages, message)
    } else {
      appendUserMessage(openaiMessages, message)
    }
  }

  return openaiMessages
}

function appendUserMessage(
  target: OpenAIChatMessage[],
  message: BetaMessageParam,
): void {
  if (typeof message.content === 'string') {
    target.push({ role: 'user', content: message.content })
    return
  }

  let userParts: OpenAIContentPart[] = []
  const flushUserParts = () => {
    if (userParts.length === 0) {
      return
    }
    const hasNonTextParts = userParts.some(part => part.type !== 'text')
    target.push({
      role: 'user',
      content: hasNonTextParts
        ? [...userParts]
        : userParts.map(part => (part.type === 'text' ? part.text : '')).join(''),
    })
    userParts = []
  }

  for (const block of message.content) {
    if (block.type === 'tool_result') {
      flushUserParts()
      target.push({
        role: 'tool',
        tool_call_id: block.tool_use_id,
        content: serializeToolResult(block),
      })
    } else {
      userParts.push(convertUserContentBlock(block))
    }
  }

  flushUserParts()
}

function appendAssistantMessage(
  target: OpenAIChatMessage[],
  message: BetaMessageParam,
): void {
  if (typeof message.content === 'string') {
    target.push({
      role: 'assistant',
      content: stripThinkingTags(message.content),
    })
    return
  }

  const textParts: string[] = []
  const toolCalls: OpenAIToolCall[] = []

  for (const block of message.content) {
    if (block.type === 'text') {
      textParts.push(block.text)
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id || createSyntheticToolUseId(),
        type: 'function',
        function: {
          name: block.name,
          arguments: safeJSONStringify(block.input ?? {}),
        },
      })
    }
  }

  target.push({
    role: 'assistant',
    content: stripThinkingTags(textParts.join('')),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  })
}

function convertUserContentBlock(
  block: Exclude<BetaContentBlockParam, BetaToolResultBlockParam>,
): OpenAIContentPart {
  if (block.type === 'text') {
    return { type: 'text', text: block.text }
  }

  if (block.type === 'image') {
    return {
      type: 'image_url',
      image_url: { url: getImageURL(block) },
    }
  }

  if (block.type === 'document') {
    return {
      type: 'text',
      text: serializePlainTextDocument(block),
    }
  }

  return {
    type: 'text',
    text: safeJSONStringify(block),
  }
}

function getImageURL(
  block: Extract<BetaContentBlockParam, { type: 'image' }>,
): string {
  if (block.source.type === 'url') {
    return block.source.url
  }

  if (block.source.type === 'base64') {
    return `data:${block.source.media_type};base64,${block.source.data}`
  }

  throw new Error(
    'OpenAI compatible provider does not support Anthropic file image blocks',
  )
}

function serializePlainTextDocument(block: BetaRequestDocumentBlock): string {
  if (block.source.type !== 'text' || block.source.media_type !== 'text/plain') {
    throw new Error(
      'OpenAI compatible provider only supports plain-text Anthropic document blocks',
    )
  }

  const parts = [block.title, block.context, block.source.data].filter(
    (value): value is string => Boolean(value),
  )
  return parts.join('\n\n')
}

function serializeToolResult(block: BetaToolResultBlockParam): string {
  const content = serializeToolResultContent(block.content)
  if (!block.is_error) {
    return content
  }
  return safeJSONStringify({ content, is_error: true })
}

function serializeToolResultContent(
  content: BetaToolResultBlockParam['content'],
): string {
  if (typeof content === 'string') {
    return content
  }

  if (!Array.isArray(content) || content.length === 0) {
    return ''
  }

  return content
    .map(block => {
      if (block.type === 'text') return block.text
      if (block.type === 'document') {
        try {
          return serializePlainTextDocument(block)
        } catch {
          return '[Document output omitted]'
        }
      }
      if (block.type === 'image') return '[Image output omitted]'
      return safeJSONStringify(block)
    })
    .join('\n')
}

function convertTools(
  tools: BetaToolUnion[] | undefined,
  model: string,
): OpenAITool[] {
  if (!tools?.length) {
    return []
  }

  return tools.map(tool => {
    if (!('input_schema' in tool)) {
      throw new Error(
        `OpenAI compatible provider does not support Anthropic builtin tool type '${tool.type ?? 'unknown'}'`,
      )
    }

    return {
      type: 'function',
      function: {
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        parameters: isGeminiModel(model)
          ? sanitizeGeminiToolSchema(tool.input_schema)
          : tool.input_schema,
        ...(tool.strict ? { strict: true } : {}),
      },
    }
  })
}

function isGeminiModel(model: string): boolean {
  const normalized = model.trim().toLowerCase()
  return /(^|[/:])gemini(?:[-_]|$)/.test(normalized)
}

function sanitizeGeminiToolSchema(schema: unknown): Record<string, unknown> {
  const sanitized = sanitizeGeminiSchemaValue(schema)
  return isRecord(sanitized) ? sanitized : {}
}

function sanitizeGeminiSchemaValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => sanitizeGeminiSchemaValue(item))
  }

  if (!isRecord(value)) {
    return value
  }

  const sanitized: Record<string, unknown> = {}
  for (const [key, nestedValue] of Object.entries(value)) {
    if (key === 'propertyNames' || key === 'const') {
      continue
    }
    sanitized[key] = sanitizeGeminiSchemaValue(nestedValue)
  }

  if ('const' in value && !('enum' in sanitized)) {
    sanitized.enum = [sanitizeGeminiSchemaValue(value.const)]
  }

  return sanitized
}

function convertToolChoice(
  toolChoice:
    | OpenAICompatibleMessageParams['tool_choice']
    | BetaToolChoiceAuto
    | BetaToolChoiceTool
    | undefined,
): {
  disableParallelToolUse: boolean | undefined
  value:
    | 'auto'
    | 'none'
    | 'required'
    | { type: 'function'; function: { name: string } }
    | undefined
} {
  if (!toolChoice) {
    return { disableParallelToolUse: undefined, value: undefined }
  }

  if (toolChoice.type === 'none') {
    return { disableParallelToolUse: undefined, value: 'none' }
  }

  if (toolChoice.type === 'any') {
    return {
      disableParallelToolUse: toolChoice.disable_parallel_tool_use,
      value: 'required',
    }
  }

  if (toolChoice.type === 'tool') {
    return {
      disableParallelToolUse: toolChoice.disable_parallel_tool_use,
      value: {
        type: 'function',
        function: { name: toolChoice.name },
      },
    }
  }

  return {
    disableParallelToolUse: toolChoice.disable_parallel_tool_use,
    value: 'auto',
  }
}

function resolveParallelToolCalls(
  model: string,
  hasTools: boolean,
  disableParallelToolUse: boolean | undefined,
): boolean | undefined {
  if (!hasTools) {
    return undefined
  }

  if (disableParallelToolUse !== undefined) {
    return !disableParallelToolUse
  }

  // OpenAI-compatible providers vary widely in how faithfully they stream
  // interleaved tool_call deltas. Default to sequential tool calls unless a
  // model config explicitly opts into parallel tool use.
  return getOpenAICompatibleParallelToolCalls(model)
}

function getSyntheticModelInfos(
  modelInfos: OpenAICompatibleModelInfo[] | undefined,
): Array<{
  capabilities: null
  created_at: string
  display_name: string
  id: string
  max_input_tokens: number | null
  max_tokens: number | null
  type: 'model'
}> {
  return (modelInfos ?? []).map(modelInfo => ({
    capabilities: null,
    created_at: '1970-01-01T00:00:00.000Z',
    display_name: modelInfo.id,
    id: modelInfo.id,
    max_input_tokens: modelInfo.max_input_tokens ?? null,
    max_tokens: modelInfo.max_tokens ?? null,
    type: 'model',
  }))
}

function buildResponseFormat(
  format: BetaJSONOutputFormat | null | undefined,
  tools: OpenAITool[],
): Record<string, unknown> | undefined {
  if (!format || tools.length > 0) {
    return undefined
  }

  return {
    type: 'json_schema',
    json_schema: {
      name: 'structured_output',
      schema: format.schema,
    },
  }
}

function getPassthroughRequestFields(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(params)) {
    if (
      value === undefined ||
      OPENAI_REQUEST_OMIT_KEYS.has(key) ||
      OPENAI_REQUEST_OMIT_EXTRA_KEYS.has(key)
    ) {
      continue
    }
    result[key] = value
  }

  return result
}

function mapOpenAIResponseToBetaMessage(
  payload: OpenAIChatCompletionResponse,
  requestedModel: string,
  response: Response,
): BetaMessage {
  const choice = payload.choices?.[0]
  const message = choice?.message
  const content: BetaContentBlock[] = []

  const text = extractAssistantText(message?.content)
  if (text) {
    content.push({ citations: null, text, type: 'text' })
  }

  for (const toolCall of message?.tool_calls ?? []) {
    content.push({
      id: toolCall.id || createSyntheticToolUseId(),
      input: parseToolArguments(toolCall.function?.arguments),
      name: toolCall.function?.name || 'unknown_tool',
      type: 'tool_use',
    })
  }

  return {
    container: null,
    content,
    context_management: null,
    id:
      payload.id ||
      response.headers.get('request-id') ||
      createSyntheticMessageId(),
    model: (payload.model || requestedModel) as BetaMessage['model'],
    role: 'assistant',
    stop_details: null,
    stop_reason: mapFinishReason(choice?.finish_reason, content),
    stop_sequence: null,
    type: 'message',
    usage: mapUsage(payload.usage),
  }
}

function createOpenAICompatibleStream(
  response: Response,
  controller: AbortController,
  requestedModel: string,
): Stream<BetaRawMessageStreamEvent> {
  return attachRequestId(
    new Stream(
      () =>
        iterateOpenAICompatibleStream(response, controller, requestedModel),
      controller,
    ),
    response.headers.get('request-id'),
  )
}

async function collectOpenAICompatibleStreamMessage(
  response: Response,
  controller: AbortController,
  requestedModel: string,
): Promise<BetaMessage> {
  const contentBlocks = new Map<number, AggregatedStreamContentBlock>()
  let baseMessage: BetaMessage | null = null
  let stopReason: BetaStopReason | null = null
  let usage = mapUsage()

  for await (const event of iterateOpenAICompatibleStream(
    response,
    controller,
    requestedModel,
  )) {
    switch (event.type) {
      case 'message_start':
        baseMessage = event.message
        usage = event.message.usage
        break
      case 'content_block_start':
        if (event.content_block.type === 'text') {
          contentBlocks.set(event.index, {
            text: event.content_block.text,
            type: 'text',
          })
          break
        }
        if (event.content_block.type === 'tool_use') {
          contentBlocks.set(event.index, {
            id: event.content_block.id,
            inputJSON: '',
            name: event.content_block.name,
            type: 'tool_use',
          })
        }
        break
      case 'content_block_delta': {
        const block = contentBlocks.get(event.index)
        if (!block) {
          throw new Error(
            'OpenAI-compatible stream emitted a delta before content_block_start',
          )
        }
        if (event.delta.type === 'text_delta') {
          if (block.type !== 'text') {
            throw new Error(
              'OpenAI-compatible stream emitted text delta for a non-text block',
            )
          }
          block.text += event.delta.text
          break
        }
        if (event.delta.type === 'input_json_delta') {
          if (block.type !== 'tool_use') {
            throw new Error(
              'OpenAI-compatible stream emitted input JSON delta for a non-tool block',
            )
          }
          block.inputJSON += event.delta.partial_json
        }
        break
      }
      case 'message_delta':
        usage = updateOpenAICompatibleStreamUsage(usage, event.usage)
        stopReason = event.delta.stop_reason
        break
      case 'content_block_stop':
      case 'message_stop':
        break
    }
  }

  const content = [...contentBlocks.entries()]
    .sort((left, right) => left[0] - right[0])
    .flatMap(([, block]): BetaContentBlock[] => {
      if (block.type === 'text') {
        if (!block.text) {
          return []
        }
        return [{ citations: null, text: block.text, type: 'text' }]
      }

      return [
        {
          id: block.id,
          input: parseToolArguments(block.inputJSON),
          name: block.name,
          type: 'tool_use',
        },
      ]
    })

  return {
    container: null,
    content,
    context_management: null,
    id:
      baseMessage?.id ||
      response.headers.get('request-id') ||
      createSyntheticMessageId(),
    model: (baseMessage?.model || requestedModel) as BetaMessage['model'],
    role: 'assistant',
    stop_details: null,
    stop_reason: stopReason ?? mapFinishReason(undefined, content),
    stop_sequence: null,
    type: 'message',
    usage,
  }
}

async function* iterateOpenAICompatibleStream(
  response: Response,
  controller: AbortController,
  requestedModel: string,
): AsyncGenerator<BetaRawMessageStreamEvent, void, unknown> {
  let emittedStart = false
  let finished = false
  let receivedStreamChunk = false
  let completedContentBlocks = 0
  let messageId = response.headers.get('request-id') || createSyntheticMessageId()
  let model = requestedModel
  let latestUsage = mapDeltaUsage()
  let lastFinishReason: string | null | undefined
  let openTextBlockIndex: number | null = null
  let nextContentIndex = 0
  let nextToolUpdateOrder = 0
  const toolStates: ToolStreamState[] = []
  const toolStatesById = new Map<string, ToolStreamState>()
  const toolStatesByIndex = new Map<number, ToolStreamState>()
  const textStripper = createThinkingTagStripper()

  const maybeEmitStart = async function* (): AsyncGenerator<
    BetaRawMessageStreamEvent,
    void,
    unknown
  > {
    if (emittedStart) {
      return
    }
    emittedStart = true
    yield {
      message: {
        container: null,
        content: [],
        context_management: null,
        id: messageId,
        model: model as BetaMessage['model'],
        role: 'assistant',
        stop_details: null,
        stop_reason: null,
        stop_sequence: null,
        type: 'message',
        usage: mapUsage(),
      },
      type: 'message_start',
    }
  }

  const emitContentBlockStop = async function* (
    index: number,
  ): AsyncGenerator<BetaRawMessageStreamEvent, void, unknown> {
    completedContentBlocks += 1
    yield { index, type: 'content_block_stop' }
  }

  try {
    for await (const data of iterateSSEData(response, controller)) {
      if (data === '[DONE]') {
        break
      }

      const chunk = JSON.parse(data) as OpenAIChatCompletionChunk
      if (chunk.error) {
        throw APIError.generate(
          response.status,
          chunk,
          undefined,
          response.headers,
        )
      }

      receivedStreamChunk = true
      if (chunk.id) messageId = chunk.id
      if (chunk.model) model = chunk.model
      if (chunk.usage) latestUsage = mapDeltaUsage(chunk.usage)

      yield* maybeEmitStart()

      for (const choice of chunk.choices ?? []) {
        if (choice.finish_reason) {
          lastFinishReason = choice.finish_reason
        }

        const delta = choice.delta
        if (!delta) continue

        if (typeof delta.content === 'string') {
          const visibleText = textStripper.push(delta.content)
          if (visibleText) {
            if (openTextBlockIndex === null) {
              openTextBlockIndex = nextContentIndex++
              yield {
                content_block: {
                  citations: null,
                  text: '',
                  type: 'text',
                },
                index: openTextBlockIndex,
                type: 'content_block_start',
              }
            }

            yield {
              delta: { text: visibleText, type: 'text_delta' },
              index: openTextBlockIndex,
              type: 'content_block_delta',
            }
          }
        }

        for (const toolCallDelta of delta.tool_calls ?? []) {
          if (openTextBlockIndex !== null) {
            yield* emitContentBlockStop(openTextBlockIndex)
            openTextBlockIndex = null
          }

          const state = resolveToolStreamState({
            nextContentIndex: () => nextContentIndex++,
            toolCallDelta,
            toolStates,
            toolStatesById,
            toolStatesByIndex,
          })

          if (toolCallDelta.index !== undefined) {
            toolStatesByIndex.set(toolCallDelta.index, state)
          }
          if (toolCallDelta.id) {
            state.id = toolCallDelta.id
            toolStatesById.set(toolCallDelta.id, state)
          }
          if (toolCallDelta.function?.name) state.name = toolCallDelta.function.name
          if (toolCallDelta.function?.arguments) {
            state.arguments += toolCallDelta.function.arguments
          }
          state.lastUpdatedOrder = ++nextToolUpdateOrder

          if (!state.started && state.name) {
            state.started = true
            yield {
              content_block: {
                id: state.id,
                input: {},
                name: state.name,
                type: 'tool_use',
              },
              index: state.contentIndex,
              type: 'content_block_start',
            }
          }

          if (state.started && state.arguments.length > state.sentArgumentsLength) {
            const partialJSON = state.arguments.slice(state.sentArgumentsLength)
            state.sentArgumentsLength = state.arguments.length
            yield {
              delta: {
                partial_json: partialJSON,
                type: 'input_json_delta',
              },
              index: state.contentIndex,
              type: 'content_block_delta',
            }
          }
        }
      }
    }

    if (receivedStreamChunk) {
      yield* maybeEmitStart()
    }

    const trailingText = textStripper.flush()
    if (trailingText) {
      if (openTextBlockIndex === null) {
        openTextBlockIndex = nextContentIndex++
        yield {
          content_block: { citations: null, text: '', type: 'text' },
          index: openTextBlockIndex,
          type: 'content_block_start',
        }
      }

      yield {
        delta: { text: trailingText, type: 'text_delta' },
        index: openTextBlockIndex,
        type: 'content_block_delta',
      }
    }

    if (openTextBlockIndex !== null) {
      yield* emitContentBlockStop(openTextBlockIndex)
    }

    const orderedToolStates = [...toolStates].sort(
      (left, right) => left.contentIndex - right.contentIndex,
    )
    for (const state of orderedToolStates) {
      validateCompletedToolStreamState(state)

      if (!state.started) {
        state.started = true
        yield {
          content_block: {
            id: state.id,
            input: {},
            name: state.name,
            type: 'tool_use',
          },
          index: state.contentIndex,
          type: 'content_block_start',
        }

        if (state.arguments.length > 0) {
          yield {
            delta: {
              partial_json: state.arguments,
              type: 'input_json_delta',
            },
            index: state.contentIndex,
            type: 'content_block_delta',
          }
        }
      }

      yield* emitContentBlockStop(state.contentIndex)
    }

    // Match claude.ts stream semantics: a stream with no chunks, or one that
    // never completes a content block and never reports an explicit finish
    // reason, is incomplete and should fall back to the non-streaming path.
    if (
      !receivedStreamChunk ||
      (completedContentBlocks === 0 && lastFinishReason == null)
    ) {
      throw new Error('Stream ended without receiving any events')
    }

    yield {
      context_management: null,
      delta: {
        container: null,
        stop_details: null,
        stop_reason: mapFinishReason(lastFinishReason, {
          length: orderedToolStates.length,
        }),
        stop_sequence: null,
      },
      type: 'message_delta',
      usage: latestUsage,
    }
    yield { type: 'message_stop' }
    finished = true
  } finally {
    if (!finished) {
      controller.abort()
    }
  }
}

function updateOpenAICompatibleStreamUsage(
  usage: BetaUsage,
  partUsage: ReturnType<typeof mapDeltaUsage> | undefined,
): BetaUsage {
  if (!partUsage) {
    return usage
  }

  return {
    ...usage,
    cache_creation: {
      ...usage.cache_creation,
    },
    cache_creation_input_tokens:
      partUsage.cache_creation_input_tokens !== null &&
      partUsage.cache_creation_input_tokens > 0
        ? partUsage.cache_creation_input_tokens
        : usage.cache_creation_input_tokens,
    cache_read_input_tokens:
      partUsage.cache_read_input_tokens !== null &&
      partUsage.cache_read_input_tokens > 0
        ? partUsage.cache_read_input_tokens
        : usage.cache_read_input_tokens,
    input_tokens:
      partUsage.input_tokens !== null && partUsage.input_tokens > 0
        ? partUsage.input_tokens
        : usage.input_tokens,
    iterations: partUsage.iterations,
    output_tokens: partUsage.output_tokens ?? usage.output_tokens,
    server_tool_use: {
      web_fetch_requests:
        partUsage.server_tool_use?.web_fetch_requests ??
        usage.server_tool_use.web_fetch_requests,
      web_search_requests:
        partUsage.server_tool_use?.web_search_requests ??
        usage.server_tool_use.web_search_requests,
    },
  }
}

async function* iterateSSEData(
  response: Response,
  controller: AbortController,
): AsyncGenerator<string, void, unknown> {
  if (!response.body) {
    controller.abort()
    throw new APIConnectionError({
      message: 'Streaming response body is missing.',
    })
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      while (true) {
        const boundaryIndex = findSSEBoundary(buffer)
        if (boundaryIndex === -1) break

        const rawEvent = buffer.slice(0, boundaryIndex)
        const separatorLength =
          buffer.startsWith('\r\n\r\n', boundaryIndex) ? 4 : 2
        buffer = buffer.slice(boundaryIndex + separatorLength)

        const data = getSSEData(rawEvent)
        if (data !== null) yield data
      }
    }

    buffer += decoder.decode()
    const finalData = getSSEData(buffer)
    if (finalData !== null) yield finalData
  } finally {
    reader.releaseLock()
  }
}

function findSSEBoundary(buffer: string): number {
  const crlfBoundary = buffer.indexOf('\r\n\r\n')
  const lfBoundary = buffer.indexOf('\n\n')

  if (crlfBoundary === -1) return lfBoundary
  if (lfBoundary === -1) return crlfBoundary
  return Math.min(crlfBoundary, lfBoundary)
}

function getSSEData(rawEvent: string): string | null {
  const lines = rawEvent.split(/\r?\n/)
  const dataLines: string[] = []

  for (const line of lines) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart())
    }
  }

  return dataLines.length > 0 ? dataLines.join('\n') : null
}

function createToolStreamState(
  contentIndex: number,
): ToolStreamState {
  return {
    arguments: '',
    contentIndex,
    id: `call_${randomUUID()}`,
    lastUpdatedOrder: 0,
    name: '',
    sentArgumentsLength: 0,
    started: false,
  }
}

function resolveToolStreamState({
  nextContentIndex,
  toolCallDelta,
  toolStates,
  toolStatesById,
  toolStatesByIndex,
}: {
  nextContentIndex: () => number
  toolCallDelta: OpenAIToolCallDelta
  toolStates: ToolStreamState[]
  toolStatesById: Map<string, ToolStreamState>
  toolStatesByIndex: Map<number, ToolStreamState>
}): ToolStreamState {
  if (toolCallDelta.index !== undefined) {
    const indexedState = toolStatesByIndex.get(toolCallDelta.index)
    if (indexedState) {
      return indexedState
    }
  }

  if (toolCallDelta.id) {
    const idState = toolStatesById.get(toolCallDelta.id)
    if (idState) {
      if (toolCallDelta.index !== undefined) {
        toolStatesByIndex.set(toolCallDelta.index, idState)
      }
      return idState
    }
  }

  const matchedState = findMatchingToolStreamState(toolCallDelta, toolStates)
  if (matchedState) {
    if (toolCallDelta.index !== undefined) {
      toolStatesByIndex.set(toolCallDelta.index, matchedState)
    }
    if (toolCallDelta.id) {
      toolStatesById.set(toolCallDelta.id, matchedState)
    }
    return matchedState
  }

  const newState = createToolStreamState(nextContentIndex())
  toolStates.push(newState)
  if (toolCallDelta.index !== undefined) {
    toolStatesByIndex.set(toolCallDelta.index, newState)
  }
  if (toolCallDelta.id) {
    toolStatesById.set(toolCallDelta.id, newState)
  }
  return newState
}

function findMatchingToolStreamState(
  toolCallDelta: OpenAIToolCallDelta,
  toolStates: ToolStreamState[],
): ToolStreamState | undefined {
  const toolName = toolCallDelta.function?.name
  if (toolName) {
    const emptyUnnamedCandidates = toolStates.filter(
      state => !state.name && state.arguments.length === 0,
    )
    if (emptyUnnamedCandidates.length === 1) {
      return emptyUnnamedCandidates[0]
    }

    const sameNameCandidates = toolStates.filter(state => state.name === toolName)
    const emptySameNameCandidates = sameNameCandidates.filter(
      state => state.arguments.length === 0,
    )
    if (emptySameNameCandidates.length === 1) {
      return emptySameNameCandidates[0]
    }

    if (
      toolCallDelta.function?.arguments === undefined &&
      sameNameCandidates.length === 1
    ) {
      return sameNameCandidates[0]
    }
  }

  if (toolCallDelta.index === undefined && !toolCallDelta.id) {
    return getMostRecentlyUpdatedToolStreamState(toolStates)
  }

  return undefined
}

function getMostRecentlyUpdatedToolStreamState(
  toolStates: ToolStreamState[],
): ToolStreamState | undefined {
  return toolStates.reduce<ToolStreamState | undefined>((latest, state) => {
    if (!latest || state.lastUpdatedOrder > latest.lastUpdatedOrder) {
      return state
    }
    return latest
  }, undefined)
}

function validateCompletedToolStreamState(state: ToolStreamState): void {
  if (!state.name) {
    throw new Error(
      'OpenAI-compatible stream ended without a tool name for a tool call',
    )
  }
}

function mapFinishReason(
  finishReason: string | null | undefined,
  content: { length: number } | BetaContentBlock[],
): BetaStopReason {
  if (finishReason === 'length') return 'max_tokens'
  if (finishReason === 'tool_calls' || finishReason === 'function_call') {
    return 'tool_use'
  }
  if (finishReason === 'content_filter') return 'refusal'
  if (hasToolUseContent(content)) return 'tool_use'
  return 'end_turn'
}

function hasToolUseContent(content: { length: number } | BetaContentBlock[]): boolean {
  if (!Array.isArray(content)) {
    return content.length > 0
  }
  return content.some(block => block.type === 'tool_use')
}

function mapUsage(usage?: OpenAIUsage): BetaUsage {
  const usageData = extractUsageNumbers(usage)
  return {
    cache_creation: {
      ephemeral_1h_input_tokens: usageData.cacheCreation1hInputTokens,
      ephemeral_5m_input_tokens: usageData.cacheCreation5mInputTokens,
    },
    cache_creation_input_tokens: usageData.cacheCreationInputTokens,
    cache_read_input_tokens: usageData.cacheReadInputTokens,
    inference_geo: null,
    input_tokens: usageData.inputTokens,
    iterations: null,
    output_tokens: usageData.outputTokens,
    server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
    service_tier: normalizeServiceTier(usage?.service_tier),
    speed: normalizeSpeed(usage?.speed),
  }
}

function mapDeltaUsage(usage?: OpenAIUsage) {
  const usageData = extractUsageNumbers(usage)
  return {
    cache_creation_input_tokens:
      usage === undefined ? null : usageData.cacheCreationInputTokens,
    cache_read_input_tokens:
      usage === undefined ? null : usageData.cacheReadInputTokens,
    input_tokens: usage === undefined ? null : usageData.inputTokens,
    iterations: null,
    output_tokens: usageData.outputTokens,
    server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
  }
}

function extractUsageNumbers(usage?: OpenAIUsage) {
  const details = isRecord(usage?.prompt_tokens_details)
    ? usage.prompt_tokens_details
    : {}
  const cacheReadInputTokens =
    getNumericValue(details.cached_tokens) ??
    getNumericValue(usage?.cache_read_input_tokens) ??
    0
  const cacheCreation5mInputTokens =
    getNumericValue(details.claude_cache_creation_5_m_tokens) ??
    getNumericValue(usage?.claude_cache_creation_5_m_tokens) ??
    0
  const cacheCreation1hInputTokens =
    getNumericValue(details.claude_cache_creation_1_h_tokens) ??
    getNumericValue(usage?.claude_cache_creation_1_h_tokens) ??
    0

  return {
    cacheCreation1hInputTokens,
    cacheCreation5mInputTokens,
    cacheCreationInputTokens:
      cacheCreation1hInputTokens + cacheCreation5mInputTokens,
    cacheReadInputTokens,
    inputTokens: getNumericValue(usage?.prompt_tokens) ?? 0,
    outputTokens: getNumericValue(usage?.completion_tokens) ?? 0,
  }
}

function extractAssistantText(
  content: OpenAIChoice['message']['content'],
): string {
  if (typeof content === 'string') {
    return stripThinkingTags(content)
  }
  if (!Array.isArray(content)) {
    return ''
  }

  const stripper = createThinkingTagStripper()
  let result = ''
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      result += stripper.push(block.text)
    }
  }
  return result + stripper.flush()
}

function parseToolArguments(argumentsJSON: string | undefined): unknown {
  if (!argumentsJSON) return {}
  try {
    return JSON.parse(argumentsJSON)
  } catch {
    return {}
  }
}

function flattenSystemPrompt(
  system: OpenAICompatibleMessageParams['system'],
): string {
  if (!system) return ''
  if (typeof system === 'string') return system
  return system.map(block => block.text).join('\n\n')
}

function stripThinkingTags(text: string): string {
  const stripper = createThinkingTagStripper()
  return stripper.push(text) + stripper.flush()
}

function createThinkingTagStripper() {
  let buffer = ''
  let insideThink = false
  let trimLeadingWhitespace = false
  let hasVisibleContent = false

  const emitVisible = (text: string): string => {
    if (!text) return ''
    let next = text
    if (trimLeadingWhitespace || !hasVisibleContent) {
      next = next.replace(/^\s+/, '')
      trimLeadingWhitespace = false
    }
    if (next) hasVisibleContent = true
    return next
  }

  return {
    flush(): string {
      if (insideThink) {
        buffer = ''
        return ''
      }
      const visible = emitVisible(buffer)
      buffer = ''
      return visible
    },
    push(chunk: string): string {
      buffer += chunk
      let visible = ''

      while (buffer.length > 0) {
        if (insideThink) {
          const closeIndex = buffer.indexOf(THINK_CLOSE_TAG)
          if (closeIndex === -1) {
            buffer = keepTagSuffix(buffer, THINK_CLOSE_TAG)
            return visible
          }
          buffer = buffer.slice(closeIndex + THINK_CLOSE_TAG.length)
          insideThink = false
          trimLeadingWhitespace = true
          continue
        }

        const openIndex = buffer.indexOf(THINK_OPEN_TAG)
        if (openIndex === -1) {
          const suffixLength = getTagSuffixLength(buffer, THINK_OPEN_TAG)
          visible += emitVisible(buffer.slice(0, buffer.length - suffixLength))
          buffer = buffer.slice(buffer.length - suffixLength)
          return visible
        }

        visible += emitVisible(buffer.slice(0, openIndex))
        buffer = buffer.slice(openIndex + THINK_OPEN_TAG.length)
        insideThink = true
      }

      return visible
    },
  }
}

function keepTagSuffix(buffer: string, tag: string): string {
  const suffixLength = getTagSuffixLength(buffer, tag)
  return buffer.slice(buffer.length - suffixLength)
}

function getTagSuffixLength(buffer: string, tag: string): number {
  const maxLength = Math.min(buffer.length, tag.length - 1)
  for (let length = maxLength; length > 0; length--) {
    if (tag.startsWith(buffer.slice(-length))) return length
  }
  return 0
}

function normalizeResponseHeaders(response: Response): Response {
  const requestId =
    response.headers.get('request-id') ??
    response.headers.get('x-request-id') ??
    response.headers.get('x-rixapi-request-id') ??
    response.headers.get('x-oneapi-request-id')
  if (!requestId) return response

  const headers = new Headers(response.headers)
  headers.set('request-id', requestId)
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  })
}

async function createAPIError(response: Response): Promise<APIError> {
  const cloned = response.clone()
  const contentType = cloned.headers.get('content-type') || ''

  if (contentType.includes('application/json')) {
    const payload = (await cloned.json()) as Record<string, unknown>
    return APIError.generate(response.status, payload, undefined, response.headers)
  }

  const message = await cloned.text()
  return APIError.generate(
    response.status,
    message ? { message } : undefined,
    message || undefined,
    response.headers,
  )
}

function forwardAbortSignal(
  source: AbortSignal | undefined,
  controller: AbortController,
): () => void {
  if (!source) return () => {}
  if (source.aborted) {
    controller.abort()
    return () => {}
  }

  const abort = () => controller.abort()
  source.addEventListener('abort', abort)
  return () => source.removeEventListener('abort', abort)
}

function getChatCompletionsURL(baseURL: string): string {
  const normalized = normalizeBaseURL(baseURL)
  if (normalized.endsWith('/chat/completions')) {
    return normalized
  }

  try {
    const url = new URL(normalized)
    const pathname = url.pathname.replace(/\/+$/, '')
    if (!pathname) {
      url.pathname = '/v1/chat/completions'
      return normalizeBaseURL(url.toString())
    }
  } catch {
    // Fall through to simple suffix append for non-URL strings.
  }

  return `${normalized}/chat/completions`
}

function normalizeBaseURL(baseURL: string): string {
  return baseURL.replace(/\/+$/, '')
}

function normalizeServiceTier(value: unknown): BetaUsage['service_tier'] {
  if (value === 'standard' || value === 'priority' || value === 'batch') {
    return value
  }
  return null
}

function normalizeSpeed(value: unknown): BetaUsage['speed'] {
  if (value === 'standard' || value === 'fast') {
    return value
  }
  return null
}

function normalizeReasoningEffort(
  value: OpenAICompatibleMessageParams['output_config']['effort'],
) {
  return value === 'max' ? 'high' : value
}

function getPromptTokensFromUsage(usage?: OpenAIUsage): number | null {
  const promptTokens = getNumericValue(usage?.prompt_tokens)
  if (promptTokens !== null) {
    return promptTokens
  }

  const totalTokens = getNumericValue(usage?.total_tokens)
  const completionTokens = getNumericValue(usage?.completion_tokens) ?? 0
  if (totalTokens !== null) {
    return Math.max(0, totalTokens - completionTokens)
  }

  return null
}

function getNumericValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function safeJSONStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {})
  } catch {
    return '{}'
  }
}

function attachRequestId<T extends object>(
  value: T,
  requestId: string | null | undefined,
): T {
  Object.defineProperty(value, '_request_id', {
    configurable: true,
    enumerable: false,
    value: requestId ?? undefined,
  })
  return value
}

function createSyntheticMessageId(): string {
  return `msg_${randomUUID()}`
}

function createSyntheticToolUseId(): string {
  return `toolu_${randomUUID()}`
}
