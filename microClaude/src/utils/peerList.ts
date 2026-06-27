import { getSessionId } from '../bootstrap/state.js'
import { getSelfBridgeCompatId } from '../bridge/replBridgeHandle.js'
import type { LiveSessionInfo } from './udsClient.js'

export type PeerTransport = 'uds' | 'bridge'

export type LivePeer = {
  address: string
  transport: PeerTransport
  name?: string
  cwd?: string
  sessionId?: string
  kind?: string
  entrypoint?: string
}

function isPeerableSession(session: LiveSessionInfo): boolean {
  return (
    session.kind === undefined ||
    session.kind === 'interactive' ||
    session.kind === 'bg'
  )
}

export function buildPeerList(sessions: LiveSessionInfo[]): LivePeer[] {
  const selfSessionId = getSessionId()
  const selfBridgeSessionId = getSelfBridgeCompatId()
  const selfSocketPath = process.env.CLAUDE_CODE_MESSAGING_SOCKET
  const peers: LivePeer[] = []
  const seenBridgeIds = new Set<string>()

  for (const session of sessions) {
    if (!isPeerableSession(session)) {
      continue
    }
    if (session.pid === process.pid || session.sessionId === selfSessionId) {
      continue
    }

    if (
      session.messagingSocketPath &&
      session.messagingSocketPath !== selfSocketPath
    ) {
      peers.push({
        address: `uds:${session.messagingSocketPath}`,
        transport: 'uds',
        name: session.name,
        cwd: session.cwd,
        sessionId: session.sessionId,
        kind: session.kind,
        entrypoint: session.entrypoint,
      })
      if (session.bridgeSessionId) {
        seenBridgeIds.add(session.bridgeSessionId)
      }
      continue
    }

    if (
      session.bridgeSessionId &&
      session.bridgeSessionId !== selfBridgeSessionId &&
      !seenBridgeIds.has(session.bridgeSessionId)
    ) {
      seenBridgeIds.add(session.bridgeSessionId)
      peers.push({
        address: `bridge:${session.bridgeSessionId}`,
        transport: 'bridge',
        name: session.name,
        cwd: session.cwd,
        sessionId: session.sessionId,
        kind: session.kind,
        entrypoint: session.entrypoint,
      })
    }
  }

  return peers
}

export function formatPeerSummary(peer: LivePeer): string {
  return [peer.address, peer.name, peer.cwd].filter(Boolean).join(' | ')
}
