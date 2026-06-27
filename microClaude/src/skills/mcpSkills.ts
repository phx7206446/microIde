import {
  type ReadResourceResult,
  ReadResourceResultSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { Command } from '../commands.js'
import type { MCPServerConnection, ServerResource } from '../services/mcp/types.js'
import { normalizeNameForMCP } from '../services/mcp/normalization.js'
import { errorMessage } from '../utils/errors.js'
import { parseFrontmatter } from '../utils/frontmatterParser.js'
import { logMCPError } from '../utils/log.js'
import { memoizeWithLRU } from '../utils/memoize.js'
import { getMCPSkillBuilders } from './mcpSkillBuilders.js'

const SKILL_URI_PREFIX = 'skill://'
const MCP_FETCH_CACHE_SIZE = 20

type ResourceTextContent = Extract<
  ReadResourceResult['contents'][number],
  { text: string }
>

function deriveSkillSegment(resource: ServerResource): string {
  const candidate =
    resource.name?.trim() ||
    resource.uri
      .slice(SKILL_URI_PREFIX.length)
      .split(/[/?#]/)[0]
      ?.trim() ||
    'skill'
  return normalizeNameForMCP(candidate)
}

function isTextResourceContent(
  content: ReadResourceResult['contents'][number],
): content is ResourceTextContent {
  return 'text' in content && typeof content.text === 'string'
}

function extractResourceMarkdown(result: ReadResourceResult): string | null {
  const textParts = result.contents
    .filter(isTextResourceContent)
    .map(content => content.text)

  if (textParts.length === 0) {
    return null
  }

  return textParts.join('\n\n')
}

async function fetchMcpSkills(
  client: MCPServerConnection,
): Promise<Command[]> {
  if (client.type !== 'connected') {
    return []
  }
  if (!client.capabilities?.resources) {
    return []
  }

  // Dynamic require avoids a module-init cycle:
  // client.ts -> require(mcpSkills.ts) -> import(client.ts).
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { ensureConnectedClient, fetchResourcesForClient } =
    require('../services/mcp/client.js') as typeof import('../services/mcp/client.js')
  /* eslint-enable @typescript-eslint/no-require-imports */

  const resources = await fetchResourcesForClient(client)
  const skillResources = resources.filter(resource =>
    resource.uri.startsWith(SKILL_URI_PREFIX),
  )

  if (skillResources.length === 0) {
    return []
  }

  const connectedClient = await ensureConnectedClient(client)
  const { createSkillCommand, parseSkillFrontmatterFields } =
    getMCPSkillBuilders()
  const serverPrefix = normalizeNameForMCP(client.name)
  const commands: Command[] = []

  for (const resource of skillResources) {
    try {
      const readResult = (await connectedClient.client.request(
        {
          method: 'resources/read',
          params: { uri: resource.uri },
        },
        ReadResourceResultSchema,
      )) as ReadResourceResult

      const markdown = extractResourceMarkdown(readResult)
      if (!markdown) {
        continue
      }

      const skillSegment = deriveSkillSegment(resource)
      if (!skillSegment) {
        continue
      }

      const skillName = `${serverPrefix}:${skillSegment}`
      const { frontmatter, content } = parseFrontmatter(
        markdown,
        `${client.name}:${resource.uri}`,
      )
      const parsed = parseSkillFrontmatterFields(frontmatter, content, skillName)

      commands.push(
        createSkillCommand({
          ...parsed,
          skillName,
          markdownContent: content,
          source: 'mcp',
          baseDir: undefined,
          loadedFrom: 'mcp',
          paths: undefined,
        }),
      )
    } catch (error) {
      logMCPError(
        client.name,
        `Failed to load MCP skill ${resource.uri}: ${errorMessage(error)}`,
      )
    }
  }

  return commands
}

export const fetchMcpSkillsForClient = memoizeWithLRU(
  fetchMcpSkills,
  (client: MCPServerConnection) => client.name,
  MCP_FETCH_CACHE_SIZE,
)
