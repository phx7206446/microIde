import type { MCPServerConnection } from '../../services/mcp/types.js'
import type { LoadedPlugin, PluginError } from '../../types/plugin.js'

export type UnifiedInstalledScope =
  | 'flagged'
  | 'project'
  | 'local'
  | 'user'
  | 'enterprise'
  | 'claudeai'
  | 'managed'
  | 'dynamic'
  | 'builtin'

type UnifiedInstalledBase = {
  id: string
  name: string
  description?: string
  scope: UnifiedInstalledScope
}

export type UnifiedPluginItem = UnifiedInstalledBase & {
  type: 'plugin'
  marketplace: string
  isEnabled: boolean
  errorCount: number
  errors: PluginError[]
  plugin: LoadedPlugin
  pendingEnable?: boolean
  pendingUpdate?: boolean
  pendingToggle?: 'will-enable' | 'will-disable'
}

export type UnifiedFlaggedPluginItem = UnifiedInstalledBase & {
  type: 'flagged-plugin'
  scope: 'flagged'
  marketplace: string
  reason: string
  text: string
  flaggedAt: string
}

export type UnifiedFailedPluginItem = UnifiedInstalledBase & {
  type: 'failed-plugin'
  marketplace: string
  errorCount: number
  errors: PluginError[]
}

export type UnifiedMcpItem = UnifiedInstalledBase & {
  type: 'mcp'
  client: MCPServerConnection
  status: MCPServerConnection['type']
  indented?: boolean
}

export type UnifiedInstalledItem =
  | UnifiedPluginItem
  | UnifiedFlaggedPluginItem
  | UnifiedFailedPluginItem
  | UnifiedMcpItem
