import type { Message } from '../types/message.js'
import { getGlobalConfig } from '../utils/config.js'
import { getCompanion } from './companion.js'

function normalizeText(text: string | null): string {
  return (text ?? '').trim().toLowerCase()
}

function hashString(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function pickVariant(seed: string, variants: readonly string[]): string {
  return variants[hashString(seed) % variants.length]!
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function hasTextBlock(
  block: unknown,
): block is {
  type: 'text'
  text: string
} {
  return (
    typeof block === 'object' &&
    block !== null &&
    'type' in block &&
    'text' in block &&
    block.type === 'text' &&
    typeof block.text === 'string'
  )
}

function extractMessageText(content: unknown): string | null {
  if (typeof content === 'string') {
    return content.trim() || null
  }
  if (!Array.isArray(content)) {
    return null
  }

  const text = content
    .filter(hasTextBlock)
    .map(block => block.text.trim())
    .filter(Boolean)
    .join('\n')

  return text || null
}

function findLatestUserText(messages: readonly Message[]): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!message || message.type !== 'user' || message.isMeta) {
      continue
    }
    const text = extractMessageText(message.message.content)
    if (text) {
      return text
    }
  }
  return null
}

function findLatestAssistantText(messages: readonly Message[]): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!message || message.type !== 'assistant') {
      continue
    }
    const text = extractMessageText(message.message.content)
    if (text) {
      return text
    }
  }
  return null
}

function computeReaction(messages: readonly Message[]): string | null {
  const companion = getCompanion()
  if (!companion || getGlobalConfig().companionMuted) {
    return null
  }

  const latestUserText = findLatestUserText(messages)
  const latestAssistantText = findLatestAssistantText(messages)
  const normalizedUserText = normalizeText(latestUserText)
  const normalizedAssistantText = normalizeText(latestAssistantText)
  const combinedText = `${normalizedUserText}\n${normalizedAssistantText}`.trim()
  if (!combinedText) {
    return null
  }

  const mentionPattern = new RegExp(`\\b${escapeRegExp(companion.name.toLowerCase())}\\b`)
  if (normalizedUserText && mentionPattern.test(normalizedUserText)) {
    return pickVariant(normalizedUserText, ['peep?', 'yep?', 'hi hi'])
  }
  if (/\b(thanks|thank you|thx|ty)\b/.test(combinedText)) {
    return pickVariant(combinedText, ['aww.', 'yay.', 'happy chirp.'])
  }
  if (/\b(error|fail(?:ed|ing)?|broken|bug|issue|exception|traceback)\b/.test(combinedText)) {
    if (/\b(fixed|resolved|patched|working|works|recovered)\b/.test(combinedText)) {
      return pickVariant(combinedText, ['recovered.', 'nice save.', 'back on track.'])
    }
    return pickVariant(combinedText, ['eep.', 'uh-oh.', 'hmm.'])
  }
  if (/\b(plan|steps?|roadmap|todo|next)\b/.test(normalizedAssistantText)) {
    return pickVariant(normalizedAssistantText, ['nice plan.', 'solid map.', 'good route.'])
  }
  if (/\b(done|fixed|implemented|updated|completed|merged|works?)\b/.test(normalizedAssistantText)) {
    return pickVariant(normalizedAssistantText, ['tidy.', 'nice.', 'nailed it.'])
  }
  if (/\b(wait|slow|thinking|loading|hang on|hang tight)\b/.test(combinedText)) {
    return pickVariant(combinedText, ['still watching.', 'hang tight.', 'keeping watch.'])
  }

  return null
}

export async function fireCompanionObserver(
  messages: readonly Message[],
  onReaction: (reaction: string) => void,
): Promise<void> {
  const reaction = computeReaction(messages)
  if (reaction) {
    onReaction(reaction)
  }
}
