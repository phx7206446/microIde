import type { LocalCommandCall } from '../../types/command.js'
import { buildPeerList, formatPeerSummary } from '../../utils/peerList.js'
import { listAllLiveSessions } from '../../utils/udsClient.js'

export const call: LocalCommandCall = async args => {
  if (args.trim() !== '') {
    return {
      type: 'text',
      value: 'Usage: /peers',
    }
  }

  const peers = buildPeerList(await listAllLiveSessions())
  if (peers.length === 0) {
    return {
      type: 'text',
      value: 'No live peers found.',
    }
  }

  return {
    type: 'text',
    value: peers.map(peer => formatPeerSummary(peer)).join('\n'),
  }
}
