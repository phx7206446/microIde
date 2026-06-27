export const AGENT_VIEW_SESSION_ENV = 'CLAUDE_CODE_AGENT_VIEW_SESSION'
export const AGENT_VIEW_PTY_ENV = 'CLAUDE_CODE_AGENT_VIEW_PTY'
export const AGENT_VIEW_DETACH_SEQUENCE =
  '\x1b]777;microclaude-agent-view-detach\x07'

export function isAgentViewSession(): boolean {
  return process.env[AGENT_VIEW_SESSION_ENV] === '1'
}

export function isAgentViewPtySession(): boolean {
  return process.env[AGENT_VIEW_PTY_ENV] === '1'
}

export function canDetachToAgentView(): boolean {
  return isAgentViewPtySession()
}

export function requestAgentViewDetach(): boolean {
  if (!canDetachToAgentView()) return false
  process.stdout.write(AGENT_VIEW_DETACH_SEQUENCE)
  return true
}
