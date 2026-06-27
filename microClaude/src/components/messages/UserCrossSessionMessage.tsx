import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import * as React from 'react'
import { CROSS_SESSION_MESSAGE_TAG } from '../../constants/xml.js'
import { extractTag } from '../../utils/messages.js'
import { UserPromptMessage } from './UserPromptMessage.js'

type Props = {
  addMargin: boolean
  param: TextBlockParam
}

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

export function UserCrossSessionMessage({
  addMargin,
  param,
}: Props): React.ReactNode {
  const crossSessionText = extractTag(param.text, CROSS_SESSION_MESSAGE_TAG)?.trim()
  if (!crossSessionText) {
    return null
  }

  return (
    <UserPromptMessage
      addMargin={addMargin}
      param={{ ...param, text: decodeBasicXmlEntities(crossSessionText) }}
    />
  )
}
