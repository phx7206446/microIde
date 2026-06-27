import type { OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthTokens } from '../../services/oauth/types.js'

export type StoredOAuthDiscoveryState = {
  authorizationServerUrl: string
  resourceMetadataUrl?: string
  resourceMetadata?: OAuthDiscoveryState['resourceMetadata']
  authorizationServerMetadata?: OAuthDiscoveryState['authorizationServerMetadata']
}

export type StoredMcpOAuthEntry = {
  serverName?: string
  serverUrl?: string
  accessToken: string
  refreshToken?: string
  expiresAt: number
  scope?: string
  clientId?: string
  clientSecret?: string
  stepUpScope?: string
  discoveryState?: StoredOAuthDiscoveryState
}

export type SecureStorageData = {
  claudeAiOauth?: OAuthTokens
  trustedDeviceToken?: string
  pluginSecrets?: Record<string, Record<string, string>>
  mcpOAuth?: Record<string, StoredMcpOAuthEntry>
  mcpOAuthClientConfig?: Record<string, { clientSecret?: string }>
  mcpXaaIdp?: Record<string, { idToken: string; expiresAt: number }>
  mcpXaaIdpConfig?: Record<string, { clientSecret: string }>
}

export type SecureStorage = {
  name: string
  read(): SecureStorageData | null
  readAsync(): Promise<SecureStorageData | null>
  update(data: SecureStorageData): { success: boolean; warning?: string }
  delete(): boolean
}
