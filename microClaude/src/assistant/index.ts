import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { basename, join, resolve } from 'path'
import { getOriginalCwd, getSessionId } from '../bootstrap/state.js'
import type { AppState } from '../state/AppStateStore.js'
import { formatAgentId } from '../utils/agentId.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import { setCliTeammateModeOverride } from '../utils/swarm/backends/teammateModeSnapshot.js'
import { TEAM_LEAD_NAME } from '../utils/swarm/constants.js'
import {
  getTeamFilePath,
  registerTeamForSessionCleanup,
  sanitizeName,
  type TeamFile,
  writeTeamFileAsync,
} from '../utils/swarm/teamHelpers.js'
import { assignTeammateColor } from '../utils/swarm/teammateLayoutManager.js'
import { ensureTasksDir, resetTaskList, setLeaderTeamName } from '../utils/tasks.js'

const FALLBACK_ASSISTANT_PROMPT = `# Assistant Mode

You are running in assistant mode.

- Send user-facing replies through SendUserMessage when that tool is available.
- Briefly acknowledge the user before longer work or background actions.
- Prioritize new user requests over background tasks and scheduled work.
- Keep updates concise and focused on useful progress.
- If background work becomes irrelevant, pause or stop it instead of continuing blindly.`

let assistantForced = false
let cachedTeamContext: NonNullable<AppState['teamContext']> | undefined

function getAssistantPromptPath(): string {
  return join(resolve(getOriginalCwd()), '.claude', 'agents', 'assistant.md')
}

function readInstalledAssistantPrompt(): string | null {
  try {
    const content = readFileSync(getAssistantPromptPath(), 'utf8').trim()
    return content.length > 0 ? content : null
  } catch {
    return null
  }
}

function getAssistantTeamName(cwd: string): string {
  const resolvedCwd = resolve(cwd)
  const baseName = sanitizeName(basename(resolvedCwd) || 'project') || 'project'
  const suffix = createHash('sha256')
    .update(resolvedCwd)
    .digest('hex')
    .slice(0, 8)
  return `assistant-${baseName}-${suffix}`
}

export function markAssistantForced(): void {
  assistantForced = true
}

export function isAssistantForced(): boolean {
  return assistantForced
}

export function isAssistantMode(): boolean {
  if (assistantForced) {
    return true
  }
  return getInitialSettings().assistant === true
}

export function getAssistantActivationPath():
  | 'cli_flag'
  | 'settings'
  | undefined {
  if (assistantForced) {
    return 'cli_flag'
  }
  return isAssistantMode() ? 'settings' : undefined
}

export function getAssistantSystemPromptAddendum(): string {
  return readInstalledAssistantPrompt() ?? FALLBACK_ASSISTANT_PROMPT
}

export async function initializeAssistantTeam(): Promise<
  NonNullable<AppState['teamContext']>
> {
  if (cachedTeamContext) {
    return cachedTeamContext
  }

  const cwd = resolve(getOriginalCwd())
  const teamName = getAssistantTeamName(cwd)
  const leadAgentId = formatAgentId(TEAM_LEAD_NAME, teamName)
  const leadColor = assignTeammateColor(leadAgentId)
  const createdAt = Date.now()
  const teamFilePath = getTeamFilePath(teamName)

  const teamFile: TeamFile = {
    name: teamName,
    description: 'Assistant mode team',
    createdAt,
    leadAgentId,
    leadSessionId: getSessionId(),
    members: [
      {
        agentId: leadAgentId,
        name: TEAM_LEAD_NAME,
        agentType: 'assistant',
        joinedAt: createdAt,
        tmuxPaneId: '',
        cwd,
        subscriptions: [],
      },
    ],
  }

  setCliTeammateModeOverride('in-process')
  await writeTeamFileAsync(teamName, teamFile)
  registerTeamForSessionCleanup(teamName)

  const taskListId = sanitizeName(teamName)
  await resetTaskList(taskListId)
  await ensureTasksDir(taskListId)
  setLeaderTeamName(taskListId)

  cachedTeamContext = {
    teamName,
    teamFilePath,
    leadAgentId,
    selfAgentId: leadAgentId,
    selfAgentName: TEAM_LEAD_NAME,
    isLeader: true,
    selfAgentColor: leadColor,
    teammates: {
      [leadAgentId]: {
        name: TEAM_LEAD_NAME,
        agentType: 'assistant',
        color: leadColor,
        tmuxSessionName: '',
        tmuxPaneId: '',
        cwd,
        spawnedAt: createdAt,
      },
    },
  }

  return cachedTeamContext
}
