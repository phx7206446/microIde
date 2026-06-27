import { mkdir, readFile, writeFile } from 'fs/promises'
import { join, resolve } from 'path'
import { getOriginalCwd } from '../bootstrap/state.js'
import { isPathTrusted } from '../utils/config.js'
import { type CronTask } from '../utils/cronTasks.js'
import { getErrnoCode } from '../utils/errors.js'
import { jsonStringify } from '../utils/slowOperations.js'
import { updateSettingsForSource } from '../utils/settings/settings.js'
import { getAssistantSystemPromptAddendum } from './index.js'

const BUILT_IN_CATCH_UP_PROMPT = `Check for anything that needs a proactive follow-up.

Prioritize:
- background tasks that finished or failed
- pending work that is blocked on user input
- queued notifications or updates that are now worth surfacing
- useful next actions that should happen while the user is away

If there is nothing useful to do or report, do nothing. Do not send filler updates.`

const BUILT_IN_MORNING_CHECKIN_PROMPT = `Morning check-in.

If there is useful context to surface from ongoing work, send a brief proactive update through SendUserMessage.

If there is no active work and the user has not heard from you yet today, send a short greeting and ask what they want to work on.

If the user is already actively chatting or has already been greeted today, do not interrupt just to repeat yourself.`

const BUILT_IN_DREAM_PROMPT = '/dream'

async function writeFileIfMissing(
  filePath: string,
  content: string,
): Promise<void> {
  try {
    await readFile(filePath, 'utf8')
    return
  } catch (error) {
    if (getErrnoCode(error) !== 'ENOENT') {
      throw error
    }
  }

  await writeFile(filePath, content, 'utf8')
}

function buildDefaultAssistantCronTasks(createdAt: number): CronTask[] {
  return [
    {
      id: 'ca7c4a11',
      cron: '7,22,37,52 * * * *',
      prompt: BUILT_IN_CATCH_UP_PROMPT,
      createdAt,
      recurring: true,
      permanent: true,
    },
    {
      id: '9a11c17f',
      cron: '17 9 * * *',
      prompt: BUILT_IN_MORNING_CHECKIN_PROMPT,
      createdAt,
      recurring: true,
      permanent: true,
    },
    {
      id: 'd3ea4170',
      cron: '17 3 * * *',
      prompt: BUILT_IN_DREAM_PROMPT,
      createdAt,
      recurring: true,
      permanent: true,
    },
  ]
}

function buildDefaultScheduledTasksFile(createdAt: number): { tasks: CronTask[] } {
  return {
    tasks: buildDefaultAssistantCronTasks(createdAt),
  }
}

export async function installAssistantProject(dir: string): Promise<void> {
  const targetDir = resolve(dir)
  const currentDir = resolve(getOriginalCwd())

  if (targetDir !== currentDir) {
    throw new Error(
      'Assistant can only be installed into the current project directory.',
    )
  }

  if (!isPathTrusted(targetDir)) {
    throw new Error(
      'Target directory is not trusted. Open Claude in that directory, accept the trust dialog, and try again.',
    )
  }

  const settingsResult = updateSettingsForSource('localSettings', {
    assistant: true,
    defaultView: 'chat',
  })
  if (settingsResult.error) {
    throw settingsResult.error
  }

  const claudeDir = join(targetDir, '.claude')
  const agentsDir = join(claudeDir, 'agents')
  const createdAt = Date.now()

  await mkdir(agentsDir, { recursive: true })
  await writeFileIfMissing(
    join(claudeDir, 'scheduled_tasks.json'),
    `${jsonStringify(buildDefaultScheduledTasksFile(createdAt), null, 2)}\n`,
  )
  await writeFileIfMissing(
    join(agentsDir, 'assistant.md'),
    `${getAssistantSystemPromptAddendum()}\n`,
  )
}
