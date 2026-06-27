import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import type { SDKControlPermissionRequest } from '../entrypoints/sdk/controlTypes.js'
import type { RemoteMessageContent } from '../utils/teleport/api.js'

export type SSHPermissionRequest = SDKControlPermissionRequest

export type SSHPermissionResponse =
  | {
      behavior: 'allow'
      updatedInput?: Record<string, unknown>
    }
  | {
      behavior: 'deny'
      message?: string
    }

export type SSHSessionManagerCallbacks = {
  onMessage: (sdkMessage: SDKMessage) => void
  onPermissionRequest: (
    request: SSHPermissionRequest,
    requestId: string,
  ) => void
  onConnected: () => void
  onReconnecting: (attempt: number, maxAttempts: number) => void
  onDisconnected: () => void
  onError: (error: Error) => void
}

export interface SSHSessionManager {
  connect(): void
  disconnect(): void
  sendMessage(content: RemoteMessageContent): Promise<boolean>
  sendInterrupt(): void
  respondToPermissionRequest(
    requestId: string,
    response: SSHPermissionResponse,
  ): void
}
