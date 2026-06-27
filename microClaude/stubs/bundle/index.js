function isTruthy(value) {
  if (value == null) return false
  switch (String(value).trim().toLowerCase()) {
    case '':
    case '0':
    case 'false':
    case 'no':
    case 'off':
      return false
    default:
      return true
  }
}

function getFeatureEnvVar(name) {
  return `CLAUDE_CODE_FEATURE_${name}`
}

const EXTERNAL_DEFAULT_ENABLED_FEATURES = new Set([
  'AGENT_MEMORY_SNAPSHOT',
  'AGENT_TRIGGERS',
  'BUILTIN_EXPLORE_PLAN_AGENTS',
  'CONTEXT_COLLAPSE',
  'COORDINATOR_MODE',
  'EXPERIMENTAL_SKILL_SEARCH',
  'EXTRACT_MEMORIES',
  'FORK_SUBAGENT',
  'KAIROS_DREAM',
  'MCP_SKILLS',
  'MONITOR_TOOL',
  'REACTIVE_COMPACT',
  'VERIFICATION_AGENT',
  'WORKFLOW_SCRIPTS',
])

let cachedEnabledFeatureSetRaw = null
let cachedEnabledFeatureSet = null

function getEnabledFeatureSet() {
  const raw = process.env.CLAUDE_CODE_FEATURES ?? ''
  if (raw === cachedEnabledFeatureSetRaw) {
    return cachedEnabledFeatureSet
  }

  cachedEnabledFeatureSetRaw = raw
  if (!raw) {
    cachedEnabledFeatureSet = null
    return cachedEnabledFeatureSet
  }

  cachedEnabledFeatureSet = new Set(
    raw
      .split(',')
      .map(entry => entry.trim())
      .filter(Boolean),
  )
  return cachedEnabledFeatureSet
}

export function feature(name) {
  const direct = process.env[getFeatureEnvVar(name)]
  if (direct !== undefined) {
    return isTruthy(direct)
  }

  const enabled = getEnabledFeatureSet()
  if (enabled?.has(name)) {
    return true
  }

  return EXTERNAL_DEFAULT_ENABLED_FEATURES.has(name)
}
