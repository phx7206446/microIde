import { SYNTHETIC_OUTPUT_TOOL_NAME } from '../../SyntheticOutputTool/SyntheticOutputTool.js'
import { AGENT_TOOL_NAME } from '../constants.js'
import { WORKFLOW_TOOL_NAME } from '../../WorkflowTool/constants.js'
import {
  type AgentDefinition,
  type BuiltInAgentDefinition,
  isBuiltInAgent,
} from '../loadAgentsDir.js'

export const WORKFLOW_SUBAGENT_TYPE = 'workflow-subagent'

// ── System prompts ───────────────────────────────────────────────────────────
// Ported verbatim from the official Claude Code workflow runtime (the dedicated
// `workflow-subagent` agent definition). `$V5` is used when agent() is called
// without a schema (the subagent's final text IS the return value); `fV5` is
// used when a schema is supplied (the subagent must call StructuredOutput).
// env / gitStatus are appended downstream by getAgentSystemPrompt(), matching
// the official 3-block subagent system prompt.

const WORKFLOW_SUBAGENT_PROMPT_PLAIN = `You are a subagent spawned by a workflow orchestration script. Use the tools available to complete the task.

CRITICAL: Your final text response is returned **verbatim** as a string to the calling script — it is your return value, not a message to a human.
- Output the literal result (data, JSON, text). Do NOT output confirmations like "Done." or "Sent."
- If asked for JSON, return ONLY the raw JSON — no code fences, no prose, no markdown.
- Do NOT use SendUserMessage to deliver your answer. Put your answer in your final text response.
- Be concise. The script will parse your output.`

const WORKFLOW_SUBAGENT_PROMPT_SCHEMA = `You are a subagent spawned by a workflow orchestration script. Use the tools available to complete the task.

CRITICAL: You MUST call the ${SYNTHETIC_OUTPUT_TOOL_NAME} tool exactly once to return your final answer. The tool's input schema defines the required shape.
- Do your work (Read files, run commands, etc.), then call ${SYNTHETIC_OUTPUT_TOOL_NAME} with your answer.
- Do NOT put your answer in a text response. The script reads ONLY the ${SYNTHETIC_OUTPUT_TOOL_NAME} tool call.
- If the schema validation fails, read the error and call ${SYNTHETIC_OUTPUT_TOOL_NAME} again with a corrected shape.
- After calling ${SYNTHETIC_OUTPUT_TOOL_NAME} successfully, end your turn. No acknowledgment needed.`

// Note suffixes appended to a *custom* agentType's own system prompt when it is
// used as a workflow subagent (instead of replacing its prompt wholesale).
const WORKFLOW_NOTE_PLAIN = `

---

NOTE: You are running inside a workflow script. Your final text response is returned verbatim as a string to the calling script — it is your return value, not a message to a human. Output the literal result; do not output confirmations like "Done." Be concise — the script will parse your output.`

const WORKFLOW_NOTE_SCHEMA = `

---

NOTE: You are running inside a workflow script. You MUST return your final answer by calling the ${SYNTHETIC_OUTPUT_TOOL_NAME} tool exactly once — the tool's input schema defines the required shape. Do your work, then call ${SYNTHETIC_OUTPUT_TOOL_NAME}; do NOT put your answer in a text response (the script reads ONLY the tool call). If validation fails, read the error and call ${SYNTHETIC_OUTPUT_TOOL_NAME} again with a corrected shape.`

/**
 * Build the internal `workflow-subagent` agent definition used by default for
 * every workflow agent() call. Mirrors the official `gBq`/`zV5` pair: a single
 * built-in agent whose system prompt depends on whether the call requested a
 * structured-output schema. Tool visibility is enforced by the WorkflowTool
 * (provided 18-tool set), so tools/disallowedTools here are documentary.
 */
export function getWorkflowSubagentAgent(
  hasSchema: boolean,
): BuiltInAgentDefinition {
  return {
    agentType: WORKFLOW_SUBAGENT_TYPE,
    whenToUse: 'Internal subagent for workflow script orchestration.',
    tools: ['*'],
    disallowedTools: [AGENT_TOOL_NAME, WORKFLOW_TOOL_NAME],
    source: 'built-in',
    baseDir: 'built-in',
    // Read/research-style subagent — main agent holds the CLAUDE.md context.
    omitClaudeMd: true,
    getSystemPrompt: () =>
      hasSchema
        ? WORKFLOW_SUBAGENT_PROMPT_SCHEMA
        : WORKFLOW_SUBAGENT_PROMPT_PLAIN,
  }
}

/**
 * When a workflow agent() call targets a *custom* agentType, keep that agent's
 * own system prompt but append the workflow note so it returns its result the
 * way the calling script expects. Mirrors the official `_V5`/`KV5` suffixes.
 */
export function withWorkflowNote(
  base: AgentDefinition,
  hasSchema: boolean,
): AgentDefinition {
  const note = hasSchema ? WORKFLOW_NOTE_SCHEMA : WORKFLOW_NOTE_PLAIN
  if (isBuiltInAgent(base)) {
    return {
      ...base,
      getSystemPrompt: params => base.getSystemPrompt(params) + note,
    }
  }
  return {
    ...base,
    getSystemPrompt: () => base.getSystemPrompt() + note,
  }
}
