import {
  getCachedMCConfig,
  type CachedMCConfig,
} from './cachedMCConfig.js'

type CacheDeleteEdit = {
  type: 'delete'
  cache_reference: string
}

export type CacheEditsBlock = {
  type: 'cache_edits'
  edits: CacheDeleteEdit[]
}

export type PinnedCacheEdits = {
  userMessageIndex: number
  block: CacheEditsBlock
}

export type CachedMCState = {
  registeredTools: Set<string>
  sentTools: Set<string>
  toolOrder: string[]
  toolMessageGroups: string[][]
  deletedRefs: Set<string>
  pinnedEdits: PinnedCacheEdits[]
}

export function createCachedMCState(): CachedMCState {
  return {
    registeredTools: new Set<string>(),
    sentTools: new Set<string>(),
    toolOrder: [],
    toolMessageGroups: [],
    deletedRefs: new Set<string>(),
    pinnedEdits: [],
  }
}

export function resetCachedMCState(state: CachedMCState): void {
  state.registeredTools.clear()
  state.sentTools.clear()
  state.toolOrder.length = 0
  state.toolMessageGroups.length = 0
  state.deletedRefs.clear()
  state.pinnedEdits.length = 0
}

export function isCachedMicrocompactEnabled(): boolean {
  return getCachedMCConfig().enabled
}

export function isModelSupportedForCacheEditing(model: string): boolean {
  return getCachedMCConfig().supportedModels.includes(model)
}

export { getCachedMCConfig }
export type { CachedMCConfig }

export function registerToolResult(state: CachedMCState, toolUseId: string): void {
  if (state.registeredTools.has(toolUseId)) {
    return
  }
  state.registeredTools.add(toolUseId)
  state.toolOrder.push(toolUseId)
}

export function registerToolMessage(
  state: CachedMCState,
  toolUseIds: string[],
): void {
  if (toolUseIds.length === 0) {
    return
  }
  state.toolMessageGroups.push([...toolUseIds])
}

export function getToolResultsToDelete(state: CachedMCState): string[] {
  const config = getCachedMCConfig()
  if (!config.enabled) {
    return []
  }

  const activeToolIds = state.toolOrder.filter(
    id => state.sentTools.has(id) && !state.deletedRefs.has(id),
  )
  if (activeToolIds.length <= config.triggerThreshold) {
    return []
  }

  const deleteCount = Math.max(0, activeToolIds.length - config.keepRecent)
  const toolIds = activeToolIds.slice(0, deleteCount)
  for (const toolUseId of toolIds) {
    state.deletedRefs.add(toolUseId)
  }
  return toolIds
}

export function createCacheEditsBlock(
  _state: CachedMCState,
  toolUseIds: string[],
): CacheEditsBlock | null {
  if (toolUseIds.length === 0) {
    return null
  }

  return {
    type: 'cache_edits',
    edits: toolUseIds.map(toolUseId => ({
      type: 'delete',
      cache_reference: toolUseId,
    })),
  }
}

export function markToolsSentToAPI(state: CachedMCState): void {
  for (const toolUseId of state.registeredTools) {
    state.sentTools.add(toolUseId)
  }
}
