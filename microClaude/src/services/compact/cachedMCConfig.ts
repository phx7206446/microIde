export type CachedMCConfig = {
  enabled: boolean
  supportedModels: string[]
  triggerThreshold: number
  keepRecent: number
  systemPromptSuggestSummaries?: boolean
}

const DEFAULT_CACHED_MC_CONFIG: CachedMCConfig = Object.freeze({
  enabled: false,
  supportedModels: [],
  triggerThreshold: 0,
  keepRecent: 0,
  systemPromptSuggestSummaries: false,
})

export function getCachedMCConfig(): CachedMCConfig {
  return DEFAULT_CACHED_MC_CONFIG
}
