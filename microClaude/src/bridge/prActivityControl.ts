import { randomUUID } from 'crypto'
import type { SDKControlResponse } from '../entrypoints/sdk/controlTypes.js'
import { logForDebugging } from '../utils/debug.js'

export type PRActivitySubscriptionAction = 'subscribe' | 'unsubscribe'

export type PRActivitySubscriptionTarget = {
  repository: string
  prNumber: number
}

export type PRActivitySubscriptionResult = {
  requestId: string
  action: PRActivitySubscriptionAction
  repository: string
  prNumber: number
  message: string
  response?: Record<string, unknown>
}

export type PendingBridgeControlResponses = Map<
  string,
  (response: SDKControlResponse) => void
>

type PRActivityControlRequest = {
  type: 'control_request'
  request_id: string
  request: {
    subtype: 'subscribe_pr_activity' | 'unsubscribe_pr_activity'
    repository: string
    pr_number: number
  }
}

const DEFAULT_TIMEOUT_MS = 15_000

function getRequestSubtype(
  action: PRActivitySubscriptionAction,
): PRActivityControlRequest['request']['subtype'] {
  return action === 'subscribe'
    ? 'subscribe_pr_activity'
    : 'unsubscribe_pr_activity'
}

function getDefaultMessage(
  action: PRActivitySubscriptionAction,
  repository: string,
  prNumber: number,
): string {
  return action === 'subscribe'
    ? `Subscribed to PR activity for ${repository}#${prNumber}.`
    : `Unsubscribed from PR activity for ${repository}#${prNumber}.`
}

export function maybeResolvePendingBridgeControlResponse(
  pendingResponses: PendingBridgeControlResponses,
  response: SDKControlResponse,
): boolean {
  const requestId = response.response?.request_id
  if (!requestId) {
    return false
  }

  const handler = pendingResponses.get(requestId)
  if (!handler) {
    return false
  }

  pendingResponses.delete(requestId)
  handler(response)
  return true
}

export async function sendPRActivityControlRequest(params: {
  action: PRActivitySubscriptionAction
  target: PRActivitySubscriptionTarget
  pendingResponses: PendingBridgeControlResponses
  send: (request: PRActivityControlRequest) => void
  logLabel: string
  timeoutMs?: number
}): Promise<PRActivitySubscriptionResult> {
  const {
    action,
    target,
    pendingResponses,
    send,
    logLabel,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = params
  const { repository, prNumber } = target
  const requestId = `pr-activity-${randomUUID()}`
  const subtype = getRequestSubtype(action)
  const request: PRActivityControlRequest = {
    type: 'control_request',
    request_id: requestId,
    request: {
      subtype,
      repository,
      pr_number: prNumber,
    },
  }

  return new Promise<PRActivitySubscriptionResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingResponses.delete(requestId)
      reject(
        new Error(
          `Timed out waiting for Remote Control to confirm ${subtype} for ${repository}#${prNumber}`,
        ),
      )
    }, timeoutMs)

    pendingResponses.set(requestId, response => {
      clearTimeout(timeout)

      const inner = response.response
      if (inner.subtype === 'error') {
        reject(
          new Error(
            inner.error ||
              `Remote Control rejected ${subtype} for ${repository}#${prNumber}`,
          ),
        )
        return
      }

      const responseData =
        inner.response && typeof inner.response === 'object'
          ? (inner.response as Record<string, unknown>)
          : undefined
      const message =
        typeof responseData?.message === 'string'
          ? responseData.message
          : getDefaultMessage(action, repository, prNumber)

      resolve({
        requestId,
        action,
        repository,
        prNumber,
        message,
        response: responseData,
      })
    })

    try {
      send(request)
      logForDebugging(
        `[${logLabel}] Sent ${subtype} request_id=${requestId} target=${repository}#${prNumber}`,
      )
    } catch (error) {
      clearTimeout(timeout)
      pendingResponses.delete(requestId)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}
