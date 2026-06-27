import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import * as React from 'react'
import {
  FORK_BOILERPLATE_TAG,
  FORK_DIRECTIVE_PREFIX,
} from '../../constants/xml.js'
import { UserPromptMessage } from './UserPromptMessage.js'

type Props = {
  addMargin: boolean
  param: TextBlockParam
}

function extractForkDirective(text: string): string | null {
  const openingTag = `<${FORK_BOILERPLATE_TAG}>`
  if (!text.includes(openingTag)) {
    return null
  }

  const closingTag = `</${FORK_BOILERPLATE_TAG}>`
  const closingTagIndex = text.indexOf(closingTag)
  if (closingTagIndex === -1) {
    return null
  }

  const remainder = text.slice(closingTagIndex + closingTag.length).trim()
  if (!remainder) {
    return null
  }

  return remainder.startsWith(FORK_DIRECTIVE_PREFIX)
    ? remainder.slice(FORK_DIRECTIVE_PREFIX.length).trim()
    : remainder
}

export function UserForkBoilerplateMessage({
  addMargin,
  param,
}: Props): React.ReactNode {
  const directive = extractForkDirective(param.text)
  if (!directive) {
    return null
  }

  return (
    <UserPromptMessage
      addMargin={addMargin}
      param={{ ...param, text: directive }}
    />
  )
}
