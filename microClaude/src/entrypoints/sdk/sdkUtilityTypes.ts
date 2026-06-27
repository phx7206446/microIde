import type {
  BetaCacheCreation,
  BetaIterationsUsage,
  BetaServerToolUsage,
  BetaUsage,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'

export type NonNullableUsage = Omit<
  BetaUsage,
  | 'cache_creation'
  | 'cache_creation_input_tokens'
  | 'cache_read_input_tokens'
  | 'inference_geo'
  | 'iterations'
  | 'server_tool_use'
  | 'service_tier'
  | 'speed'
> & {
  cache_creation: BetaCacheCreation
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  inference_geo: string
  iterations: BetaIterationsUsage
  server_tool_use: BetaServerToolUsage
  service_tier: Exclude<BetaUsage['service_tier'], null>
  speed: Exclude<BetaUsage['speed'], null>
}
