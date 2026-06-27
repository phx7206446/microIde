import { randomUUID } from 'crypto'
import { getSessionId } from '../bootstrap/state.js'
import type { SDKUserMessage } from '../entrypoints/agentSdkTypes.js'
import { errorMessage } from '../utils/errors.js'
import { escapeXml, escapeXmlAttr } from '../utils/xml.js'
import { getSelfBridgeCompatId } from './replBridgeHandle.js'
import { toCompatSessionId } from './sessionIdCompat.js'

export type InterClaudeMessageResult =
  | { ok: true; error?: undefined }
  | { ok: false; error: string }

export async function postInterClaudeMessage(
  targetSessionId: string,
  message: string,
): Promise<InterClaudeMessageResult> {
  try {
    const fromSessionId = getSelfBridgeCompatId()
    if (!fromSessionId) {
      return {
        ok: false,
        error: 'Remote Control is not connected',
      }
    }

    const { getClaudeAIOAuthTokens } = await import('../utils/auth.js')
    const { getOrganizationUUID } = await import('../services/oauth/client.js')
    const { getOauthConfig } = await import('../constants/oauth.js')
    const { getOAuthHeaders } = await import('../utils/teleport/api.js')
    const { default: axios } = await import('axios')

    const accessToken = getClaudeAIOAuthTokens()?.accessToken
    if (!accessToken) {
      return {
        ok: false,
        error:
          'Claude Code web sessions require authentication with a Claude.ai account. API key authentication is not sufficient. Please run /login to authenticate, or check your authentication status with /status.',
      }
    }
    const organizationUUID = await getOrganizationUUID()
    if (!organizationUUID) {
      return {
        ok: false,
        error: 'Unable to get organization UUID',
      }
    }

    const compatSessionId = toCompatSessionId(targetSessionId)
    const wrappedMessage = `<cross-session-message from="${escapeXmlAttr(`bridge:${fromSessionId}`)}">${escapeXml(message)}</cross-session-message>`
    const sdkMessage: SDKUserMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: wrappedMessage }],
      },
      parent_tool_use_id: null,
      session_id: getSessionId(),
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
    }

    const response = await axios.post(
      `${getOauthConfig().BASE_API_URL}/v1/sessions/${compatSessionId}/events`,
      { events: [sdkMessage] },
      {
        headers: {
          ...getOAuthHeaders(accessToken),
          'anthropic-beta': 'ccr-byoc-2025-07-29',
          'x-organization-uuid': organizationUUID,
        },
        timeout: 10_000,
        validateStatus: status => status < 500,
      },
    )

    if (response.status === 200 || response.status === 204) {
      return { ok: true }
    }

    const detail =
      response.data && typeof response.data === 'object' && 'error' in response.data
        ? String(response.data.error)
        : response.data && typeof response.data === 'object' && 'detail' in response.data
          ? String(response.data.detail)
          : `HTTP ${response.status}`

    return { ok: false, error: detail }
  } catch (e) {
    return {
      ok: false,
      error: errorMessage(e),
    }
  }
}
