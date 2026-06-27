// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { feature } from 'bun:bundle'
import { getInitialSettings } from './settings/settings.js'
import { getAPIProvider } from './model/providers.js'
import { get3PModelCapabilityOverride } from './model/modelSupportOverrides.js'
import { isEnvTruthy } from './envUtils.js'
import { areWorkflowsDisabled } from './workflowSettings.js'
import type { EffortLevel } from 'src/entrypoints/sdk/runtimeTypes.js'

export type { EffortLevel }

export type UltracodeEffort = 'ultracode'
export type PersistableEffortLevel = Exclude<EffortLevel, 'max'>

export const EFFORT_LEVELS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly EffortLevel[]

export type EffortValue = EffortLevel | UltracodeEffort | number

// @[MODEL LAUNCH]: Add the new model to the allowlist if it supports the effort parameter.
export function modelSupportsEffort(model: string): boolean {
  const m = model.toLowerCase()
  if (isEnvTruthy(process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT)) {
    return true
  }
  const supported3P = get3PModelCapabilityOverride(model, 'effort')
  if (supported3P !== undefined) {
    return supported3P
  }
  // Supported by a subset of Claude 4 models
  if (
    m.includes('opus-4-6') ||
    m.includes('sonnet-4-6') ||
    m.includes('opus-4-7') ||
    m.includes('sonnet-4-7')
  ) {
    return true
  }
  // Exclude any other known legacy models (haiku, older opus/sonnet variants)
  if (m.includes('haiku') || m.includes('sonnet') || m.includes('opus')) {
    return false
  }

  // IMPORTANT: Do not change the default effort support without notifying
  // the model launch DRI and research. This is a sensitive setting that can
  // greatly affect model quality and bashing.

  // Default to true for unknown model strings on 1P.
  // Do not default to true for 3P as they have different formats for their
  // model strings (ex. anthropics/claude-code#30795)
  return getAPIProvider() === 'firstParty'
}

// @[MODEL LAUNCH]: Add the new model to the allowlist if it supports 'xhigh' effort.
export function modelSupportsXHighEffort(model: string): boolean {
  const supported3P = get3PModelCapabilityOverride(model, 'xhigh_effort')
  if (supported3P !== undefined) {
    return supported3P
  }
  return model.toLowerCase().includes('opus-4-7')
}

// @[MODEL LAUNCH]: Add the new model to the allowlist if it supports 'max' effort.
// Keep this allowlist aligned with the public model capability matrix.
export function modelSupportsMaxEffort(model: string): boolean {
  const supported3P = get3PModelCapabilityOverride(model, 'max_effort')
  if (supported3P !== undefined) {
    return supported3P
  }
  const m = model.toLowerCase()
  if (
    m.includes('opus-4-6') ||
    m.includes('opus-4-7') ||
    m.includes('sonnet-4-6')
  ) {
    return true
  }
  return false
}

export function getSupportedEffortLevels(model: string): EffortLevel[] {
  if (!modelSupportsEffort(model)) {
    return []
  }
  return EFFORT_LEVELS.filter(level => {
    if (level === 'xhigh') return modelSupportsXHighEffort(model)
    if (level === 'max') return modelSupportsMaxEffort(model)
    return true
  })
}

export function supportsUltracodeEffort(model: string): boolean {
  return (
    feature('WORKFLOW_SCRIPTS') &&
    !areWorkflowsDisabled() &&
    modelSupportsXHighEffort(model)
  )
}

export function clampEffortLevelForModel(
  model: string,
  level: EffortLevel,
): EffortLevel {
  return getSupportedEffortLevels(model).includes(level) ? level : 'high'
}

export function isEffortLevel(value: string): value is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(value)
}

export function isUltracodeEffort(value: unknown): value is UltracodeEffort {
  return value === 'ultracode'
}

export function parseEffortValue(value: unknown): EffortValue | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  if (typeof value === 'number' && isValidNumericEffort(value)) {
    return value
  }
  const str = String(value).toLowerCase()
  if (isUltracodeEffort(str)) {
    return str
  }
  if (isEffortLevel(str)) {
    return str
  }
  const numericValue = parseInt(str, 10)
  if (!isNaN(numericValue) && isValidNumericEffort(numericValue)) {
    return numericValue
  }
  return undefined
}

/**
 * Numeric values are model-default only and not persisted.
 * 'max' is session-scoped for external users (ants can persist it).
 * Write sites call this before saving to settings so the Zod schema
 * (which only accepts string levels) never rejects a write.
 */
export function toPersistableEffort(
  value: EffortValue | undefined,
): PersistableEffortLevel | undefined {
  if (
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh'
  ) {
    return value
  }
  return undefined
}

export function getInitialEffortSetting(): EffortLevel | undefined {
  // toPersistableEffort filters 'max' on read, so a manually
  // edited settings.json doesn't leak session-scoped max into a fresh session.
  return toPersistableEffort(getInitialSettings().effortLevel)
}

/**
 * Decide what effort level (if any) to persist when the user selects a model
 * in ModelPicker. Keeps an explicit prior /effort choice sticky even when it
 * matches the picked model's default, while letting purely-default and
 * session-ephemeral effort (CLI --effort, EffortCallout default) fall through
 * to undefined so it follows future model-default changes.
 *
 * priorPersisted must come from userSettings on disk
 * (getSettingsForSource('userSettings')?.effortLevel), NOT merged settings
 * (project/policy layers would leak into the user's global settings.json)
 * and NOT AppState.effortValue (includes session-scoped sources that
 * deliberately do not write to settings.json).
 */
export function resolvePickerEffortPersistence(
  picked: EffortLevel | undefined,
  modelDefault: EffortLevel,
  priorPersisted: EffortLevel | undefined,
  toggledInPicker: boolean,
): EffortLevel | undefined {
  const hadExplicit = priorPersisted !== undefined || toggledInPicker
  return hadExplicit || picked !== modelDefault ? picked : undefined
}

export type EffortEnvOverride = EffortValue | 'auto' | null | undefined

export function getEffortEnvOverride(): EffortEnvOverride {
  const envOverride = process.env.CLAUDE_CODE_EFFORT_LEVEL
  const normalized = envOverride?.toLowerCase()
  if (normalized === undefined) {
    return undefined
  }
  if (normalized === 'unset') {
    return null
  }
  if (normalized === 'auto') {
    return 'auto'
  }
  return parseEffortValue(envOverride)
}

/**
 * Resolve the effort value that will actually be sent to the API for a given
 * model, following the full precedence chain:
 *   env CLAUDE_CODE_EFFORT_LEVEL → appState.effortValue → model default
 *
 * Returns undefined when no effort parameter should be sent (env set to
 * 'unset', or no default exists for the model).
 */
export function resolveAppliedEffort(
  model: string,
  appStateEffortValue: EffortValue | undefined,
): EffortValue | undefined {
  if (!modelSupportsEffort(model)) {
    return undefined
  }
  const envOverride = getEffortEnvOverride()
  if (envOverride === null) {
    return undefined
  }
  const resolved =
    envOverride === 'auto'
      ? getDefaultEffortForModel(model)
      : envOverride ?? appStateEffortValue ?? getDefaultEffortForModel(model)
  // API rejects unsupported string levels; downgrade to 'high' before sending.
  if (typeof resolved === 'string') {
    if (isUltracodeEffort(resolved)) {
      return modelSupportsXHighEffort(model) ? 'xhigh' : undefined
    }
    return clampEffortLevelForModel(model, resolved)
  }
  return resolved
}

export function resolveAppliedEffortLevel(
  model: string,
  appStateEffortValue: EffortValue | undefined,
): EffortLevel | undefined {
  const resolved = resolveAppliedEffort(model, appStateEffortValue)
  if (resolved === undefined) return undefined
  return convertEffortValueToLevel(resolved)
}

/**
 * Resolve the effort level to show the user. Wraps resolveAppliedEffort
 * with the 'high' fallback (what the API uses when no effort param is sent).
 * Single source of truth for the status bar and /effort output (CC-1088).
 */
export function getDisplayedEffortLevel(
  model: string,
  appStateEffort: EffortValue | undefined,
): EffortLevel {
  return resolveAppliedEffortLevel(model, appStateEffort) ?? 'high'
}

/**
 * Build the ` with {level} effort` suffix shown in Logo/Spinner.
 * Returns empty string if the user hasn't explicitly set an effort value.
 * Delegates to resolveAppliedEffort() so the displayed level matches what
 * the API actually receives (including max→high clamp for non-Opus models).
 */
export function getEffortSuffix(
  model: string,
  effortValue: EffortValue | undefined,
): string {
  if (effortValue === undefined) return ''
  const resolved = resolveAppliedEffortLevel(model, effortValue)
  if (resolved === undefined) return ''
  return ` with ${resolved} effort`
}

export function getEffortEnvForChildProcess(
  model: string,
  appStateEffort: EffortValue | undefined,
): Record<string, string> {
  const level = resolveAppliedEffortLevel(model, appStateEffort)
  return level === undefined ? {} : { CLAUDE_EFFORT: level }
}

export function isValidNumericEffort(value: number): boolean {
  return Number.isInteger(value)
}

export function convertEffortValueToLevel(value: EffortValue): EffortLevel {
  if (typeof value === 'string') {
    if (isUltracodeEffort(value)) return 'xhigh'
    // Runtime guard: value may come from remote config (GrowthBook) where
    // TypeScript types can't help us. Coerce unknown strings to 'high'
    // rather than passing them through unchecked.
    return isEffortLevel(value) ? value : 'high'
  }
  return 'high'
}

/**
 * Get user-facing description for effort levels
 *
 * @param level The effort level to describe
 * @returns Human-readable description
 */
export function getEffortLevelDescription(level: EffortLevel): string {
  switch (level) {
    case 'low':
      return 'Quick, straightforward implementation with minimal overhead'
    case 'medium':
      return 'Balanced approach with standard implementation and testing'
    case 'high':
      return 'Comprehensive implementation with extensive testing and documentation'
    case 'xhigh':
      return 'Extra high capability for especially complex tasks'
    case 'max':
      return 'Maximum capability with deepest reasoning on supported models'
  }
}

/**
 * Get user-facing description for effort values (both string and numeric)
 *
 * @param value The effort value to describe
 * @returns Human-readable description
 */
export function getEffortValueDescription(value: EffortValue): string {
  if (typeof value === 'string') {
    if (isUltracodeEffort(value)) {
      return 'Generate and run dynamic workflows automatically for future prompts'
    }
    return getEffortLevelDescription(value)
  }
  return 'Balanced approach with standard implementation and testing'
}

// @[MODEL LAUNCH]: Update the default effort levels for new models
export function getDefaultEffortForModel(
  model: string,
): EffortValue | undefined {
  // IMPORTANT: Do not change the default effort level without notifying
  // the model launch DRI and research. Default effort is a sensitive setting
  // that can greatly affect model quality and bashing.

  const m = model.toLowerCase()
  if (m.includes('opus-4-7')) {
    return 'xhigh'
  }
  if (m.includes('opus-4-6') || m.includes('sonnet-4-6')) {
    return 'high'
  }

  // Fallback to undefined, which means we don't set an effort level.
  return undefined
}
