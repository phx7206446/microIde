import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js'
import {
  getBinaryBlobSavedMessage,
  persistBinaryContent,
} from '../../utils/mcpOutputStorage.js'

export type MaterializedResourceContent = {
  uri: string
  mimeType?: string
  text?: string
  blobSavedTo?: string
}

export async function materializeReadResourceResult({
  serverName,
  result,
  messagePrefix,
  persistPrefix = 'mcp-resource',
}: {
  serverName: string
  result: ReadResourceResult
  messagePrefix?: string
  persistPrefix?: string
}): Promise<MaterializedResourceContent[]> {
  return Promise.all(
    result.contents.map(async (content, index) => {
      if ('text' in content) {
        return {
          uri: content.uri,
          mimeType: content.mimeType,
          text: content.text,
        }
      }

      if (!('blob' in content) || typeof content.blob !== 'string') {
        return {
          uri: content.uri,
          mimeType: content.mimeType,
        }
      }

      const persistId = `${persistPrefix}-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`
      const persisted = await persistBinaryContent(
        Buffer.from(content.blob, 'base64'),
        content.mimeType,
        persistId,
      )

      if ('error' in persisted) {
        return {
          uri: content.uri,
          mimeType: content.mimeType,
          text: `Binary content could not be saved to disk: ${persisted.error}`,
        }
      }

      return {
        uri: content.uri,
        mimeType: content.mimeType,
        blobSavedTo: persisted.filepath,
        text: getBinaryBlobSavedMessage(
          persisted.filepath,
          content.mimeType,
          persisted.size,
          messagePrefix ?? `[Resource from ${serverName} at ${content.uri}] `,
        ),
      }
    }),
  )
}
