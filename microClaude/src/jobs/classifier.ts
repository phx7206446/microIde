import { mkdir, rename, writeFile } from 'fs/promises'
import { basename, join } from 'path'
import type { AssistantMessage } from '../types/message.js'

type JobState = {
  jobId: string
  status: 'pending' | 'running' | 'waiting' | 'completed' | 'failed'
  summary: string
  updatedAt: string
  assistantMessageCount: number
  lastAssistantText?: string
  lastToolUses?: string[]
}

function getAssistantText(message: AssistantMessage): string {
  return message.message.content
    .map(block => (block.type === 'text' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim()
}

function getToolUseNames(message: AssistantMessage): string[] {
  return message.message.content
    .filter(
      (block): block is Extract<typeof block, { type: 'tool_use' }> =>
        block.type === 'tool_use',
    )
    .map(block => block.name)
}

function classifyState(assistantMessages: readonly AssistantMessage[]): Omit<JobState, 'jobId' | 'updatedAt'> {
  const lastMessage = assistantMessages.at(-1)
  if (!lastMessage) {
    return {
      status: 'pending',
      summary: 'Waiting for the first assistant response',
      assistantMessageCount: 0,
    }
  }

  if (lastMessage.isApiErrorMessage || lastMessage.apiError) {
    return {
      status: 'failed',
      summary: 'Latest turn ended with an API error',
      assistantMessageCount: assistantMessages.length,
      lastAssistantText: getAssistantText(lastMessage) || undefined,
    }
  }

  const toolUses = getToolUseNames(lastMessage)
  if (toolUses.length > 0) {
    return {
      status: 'running',
      summary: `Running tools: ${toolUses.join(', ')}`,
      assistantMessageCount: assistantMessages.length,
      lastAssistantText: getAssistantText(lastMessage) || undefined,
      lastToolUses: toolUses,
    }
  }

  const text = getAssistantText(lastMessage)
  const normalized = text.toLowerCase()
  if (/\?$/.test(text) || /\b(let me know|could you|can you|please provide)\b/.test(normalized)) {
    return {
      status: 'waiting',
      summary: text || 'Waiting for user input',
      assistantMessageCount: assistantMessages.length,
      lastAssistantText: text || undefined,
    }
  }

  if (/\b(done|completed|finished|fixed|implemented|resolved)\b/.test(normalized)) {
    return {
      status: 'completed',
      summary: text || 'Completed',
      assistantMessageCount: assistantMessages.length,
      lastAssistantText: text || undefined,
    }
  }

  return {
    status: 'running',
    summary: text || 'In progress',
    assistantMessageCount: assistantMessages.length,
    lastAssistantText: text || undefined,
  }
}

export async function classifyAndWriteState(
  jobDir: string,
  assistantMessages: readonly AssistantMessage[],
): Promise<void> {
  await mkdir(jobDir, { recursive: true })

  const state: JobState = {
    jobId: basename(jobDir),
    updatedAt: new Date().toISOString(),
    ...classifyState(assistantMessages),
  }

  const statePath = join(jobDir, 'state.json')
  const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tempPath, JSON.stringify(state, null, 2) + '\n', 'utf8')
  await rename(tempPath, statePath)
}
