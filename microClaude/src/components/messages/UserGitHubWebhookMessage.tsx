import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import * as React from 'react'
import { extractTag } from '../../utils/messages.js'
import { UserPromptMessage } from './UserPromptMessage.js'

type Props = {
  addMargin: boolean
  param: TextBlockParam
}

const GITHUB_WEBHOOK_ACTIVITY_TAG = 'github-webhook-activity'

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

export function UserGitHubWebhookMessage({
  addMargin,
  param,
}: Props): React.ReactNode {
  const webhookText = extractTag(param.text, GITHUB_WEBHOOK_ACTIVITY_TAG)?.trim()
  if (!webhookText) {
    return null
  }

  return (
    <UserPromptMessage
      addMargin={addMargin}
      param={{ ...param, text: decodeBasicXmlEntities(webhookText) }}
    />
  )
}
