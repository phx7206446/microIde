import { fetchCodeSessionsFromSessionsAPI } from '../utils/teleport/api.js'

const ACTIVE_SESSION_STATUSES = new Set([
  'idle',
  'running',
  'requires_action',
])

export type AssistantSession = {
  id: string
  title: string
  status: string
  updatedAt: string
  createdAt: string
}

export async function discoverAssistantSessions(): Promise<
  AssistantSession[]
> {
  const sessions = await fetchCodeSessionsFromSessionsAPI()

  return sessions
    .map(session => ({
      id: String(session.id ?? '').trim(),
      title: String(session.title ?? 'Untitled').trim() || 'Untitled',
      status: String(session.status ?? '').trim(),
      updatedAt: String(session.updated_at ?? ''),
      createdAt: String(session.created_at ?? ''),
    }))
    .filter(
      session =>
        session.id.length > 0 &&
        ACTIVE_SESSION_STATUSES.has(session.status),
    )
    .sort(
      (a, b) =>
        b.updatedAt.localeCompare(a.updatedAt) ||
        b.createdAt.localeCompare(a.createdAt) ||
        b.id.localeCompare(a.id),
    )
}
