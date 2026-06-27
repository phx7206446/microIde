import { resetSocketState } from '../../utils/tmuxSocket.js'

export const TungstenTool = null

export function clearSessionsWithTungstenUsage(): void {
  resetSocketState()
}

export function resetInitializationState(): void {
  resetSocketState()
}
