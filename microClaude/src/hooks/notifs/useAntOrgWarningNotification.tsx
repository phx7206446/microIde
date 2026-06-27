import type { Notification } from '../../context/notifications.js'
import { getOrganizationUUID } from '../../services/oauth/client.js'
import { getOauthAccountInfo } from '../../utils/auth.js'
import { safeParseJSON } from '../../utils/json.js'
import { useStartupNotification } from './useStartupNotification.js'

type AntOrgWarningRule = {
  orgUuids: string[]
  message: string
  key?: string
  timeoutMs?: number
  priority?: Notification['priority']
}

const STATIC_WARNING_RULES: readonly AntOrgWarningRule[] = []

function normalizeRule(value: unknown): AntOrgWarningRule | null {
  if (
    !value ||
    typeof value !== 'object' ||
    !Array.isArray((value as { orgUuids?: unknown }).orgUuids) ||
    typeof (value as { message?: unknown }).message !== 'string'
  ) {
    return null
  }

  const orgUuids = (value as { orgUuids: unknown[] }).orgUuids.filter(
    (orgUuid): orgUuid is string => typeof orgUuid === 'string' && orgUuid.length > 0,
  )
  if (orgUuids.length === 0) {
    return null
  }

  const priority = (value as { priority?: unknown }).priority
  return {
    orgUuids,
    message: (value as { message: string }).message,
    key:
      typeof (value as { key?: unknown }).key === 'string'
        ? (value as { key: string }).key
        : undefined,
    timeoutMs:
      typeof (value as { timeoutMs?: unknown }).timeoutMs === 'number'
        ? (value as { timeoutMs: number }).timeoutMs
        : undefined,
    priority:
      priority === 'low' ||
      priority === 'medium' ||
      priority === 'high' ||
      priority === 'immediate'
        ? priority
        : undefined,
  }
}

function getEnvWarningRules(): AntOrgWarningRule[] {
  const parsed = safeParseJSON(process.env.CLAUDE_CODE_ANT_ORG_WARNING_RULES, false)
  if (!Array.isArray(parsed)) {
    return []
  }
  return parsed
    .map(normalizeRule)
    .filter((rule): rule is AntOrgWarningRule => rule !== null)
}

function findMatchingWarning(orgUuid: string): AntOrgWarningRule | undefined {
  return [...STATIC_WARNING_RULES, ...getEnvWarningRules()].find(rule =>
    rule.orgUuids.includes(orgUuid),
  )
}

export function useAntOrgWarningNotification(): void {
  useStartupNotification(async () => {
    if (process.env.USER_TYPE !== 'ant') {
      return null
    }

    const orgUuid =
      getOauthAccountInfo()?.organizationUuid ?? (await getOrganizationUUID())
    if (!orgUuid) {
      return null
    }

    const warning = findMatchingWarning(orgUuid)
    if (!warning) {
      return null
    }

    return {
      key: warning.key ?? `ant-org-warning:${orgUuid}`,
      text: warning.message,
      color: 'warning',
      priority: warning.priority ?? 'high',
      timeoutMs: warning.timeoutMs ?? 15000,
    } satisfies Notification
  })
}
