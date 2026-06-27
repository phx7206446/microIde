export const DISCOVERY_SIGNALS = [
  'user_message',
  'assistant_turn',
  'subagent_spawn',
  'filesystem',
] as const

export type DiscoverySignal = (typeof DISCOVERY_SIGNALS)[number]

export function isDiscoverySignal(value: unknown): value is DiscoverySignal {
  return (
    typeof value === 'string' &&
    DISCOVERY_SIGNALS.includes(value as DiscoverySignal)
  )
}
