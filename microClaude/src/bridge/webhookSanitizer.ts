import type {
  ContentBlockParam,
  TextBlockParam,
} from '@anthropic-ai/sdk/resources/messages.mjs'
import { escapeXml } from '../utils/xml.js'

const GITHUB_WEBHOOK_ACTIVITY_TAG = 'github-webhook-activity'
const GITHUB_WEBHOOK_OPEN = `<${GITHUB_WEBHOOK_ACTIVITY_TAG}>`
const GITHUB_WEBHOOK_CLOSE = `</${GITHUB_WEBHOOK_ACTIVITY_TAG}>`

function decodeBasicXmlEntities(text: string): string {
  let current = text
  for (let i = 0; i < 4; i++) {
    const next = current
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
    if (next === current) {
      return next
    }
    current = next
  }
  return current
}

function sanitizeWebhookString(content: string): string {
  if (!content.startsWith(GITHUB_WEBHOOK_OPEN)) {
    return content
  }

  const closeIndex = content.lastIndexOf(GITHUB_WEBHOOK_CLOSE)
  if (closeIndex === -1) {
    return content
  }

  const inner = content.slice(GITHUB_WEBHOOK_OPEN.length, closeIndex)
  const sanitizedInner = escapeXml(
    decodeBasicXmlEntities(inner).replace(/\r\n?/g, '\n'),
  )
  if (sanitizedInner === inner) {
    return content
  }

  return `${GITHUB_WEBHOOK_OPEN}${sanitizedInner}${content.slice(closeIndex)}`
}

function isTextBlock(block: ContentBlockParam): block is TextBlockParam {
  return block.type === 'text' && typeof block.text === 'string'
}

export function sanitizeInboundWebhookContent<T>(content: T): T {
  if (typeof content === 'string') {
    return sanitizeWebhookString(content) as T
  }

  if (!Array.isArray(content)) {
    return content
  }

  let changed = false
  const sanitized = content.map(block => {
    if (!isTextBlock(block)) {
      return block
    }

    const text = sanitizeWebhookString(block.text)
    if (text === block.text) {
      return block
    }

    changed = true
    return { ...block, text }
  })

  return (changed ? sanitized : content) as T
}
