import React from 'react'
import { z } from 'zod/v4'
import { Box, Text } from '../../ink.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  buildPeerList,
  formatPeerSummary,
  type LivePeer,
} from '../../utils/peerList.js'
import {
  listAllLiveSessions,
} from '../../utils/udsClient.js'

const LIST_PEERS_TOOL_NAME = 'ListPeers'
const DESCRIPTION =
  'List live local and Remote Control peers that can receive SendMessage.'

const inputSchema = lazySchema(() => z.strictObject({}))
type InputSchema = ReturnType<typeof inputSchema>

const peerSchema = z.object({
  address: z.string(),
  transport: z.enum(['uds', 'bridge']),
  name: z.string().optional(),
  cwd: z.string().optional(),
  sessionId: z.string().optional(),
  kind: z.string().optional(),
  entrypoint: z.string().optional(),
})

const outputSchema = lazySchema(() =>
  z.object({
    count: z.number().int(),
    peers: z.array(peerSchema),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
type Output = z.infer<OutputSchema>

type Peer = Output['peers'][number] & LivePeer

function renderPeer(peer: Peer): React.ReactNode {
  return (
    <Box key={peer.address} flexDirection="column" marginBottom={1}>
      <Text>{peer.address}</Text>
      <Text dimColor>
        {[peer.name, peer.cwd, peer.kind].filter(Boolean).join(' · ') ||
          peer.transport}
      </Text>
    </Box>
  )
}

export const ListPeersTool = buildTool({
  name: LIST_PEERS_TOOL_NAME,
  searchHint: 'discover SendMessage targets',
  maxResultSizeChars: 10_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return 'Use this before SendMessage to discover live UDS and Remote Control peers.'
  },
  renderToolUseMessage() {
    return <Text>Listing peers</Text>
  },
  renderToolResultMessage(output) {
    if (output.peers.length === 0) {
      return <Text dimColor>No live peers found</Text>
    }

    return <Box flexDirection="column">{output.peers.map(renderPeer)}</Box>
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const content =
      output.peers.length === 0
        ? 'No live peers found.'
        : output.peers
            .map(peer => formatPeerSummary(peer))
            .join('\n')

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content,
    }
  },
  async call() {
    const peers = buildPeerList(await listAllLiveSessions())
    return {
      data: {
        count: peers.length,
        peers,
      },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
