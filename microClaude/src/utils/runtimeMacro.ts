export type RuntimeMacro = {
  BUILD_TIME: string
  FEEDBACK_CHANNEL: string
  ISSUES_EXPLAINER: string
  NATIVE_PACKAGE_URL: string
  PACKAGE_URL: string
  VERSION: string
  VERSION_CHANGELOG: string
}

const DEFAULT_RUNTIME_MACRO: RuntimeMacro = {
  BUILD_TIME: '',
  FEEDBACK_CHANNEL: 'the issue tracker',
  ISSUES_EXPLAINER: 'report the issue to the project maintainer',
  NATIVE_PACKAGE_URL: '',
  PACKAGE_URL: 'micro-claude',
  VERSION: process.env.CLAUDE_CODE_VERSION || '0.2.0',
  VERSION_CHANGELOG: '',
}

export function getRuntimeMacro(): RuntimeMacro {
  const runtimeGlobal = globalThis as typeof globalThis & {
    MACRO?: Partial<RuntimeMacro>
  }
  const runtimeMacro =
    typeof runtimeGlobal === 'object' &&
    runtimeGlobal !== null &&
    typeof runtimeGlobal.MACRO === 'object' &&
    runtimeGlobal.MACRO !== null
      ? runtimeGlobal.MACRO
      : {}

  return {
    ...DEFAULT_RUNTIME_MACRO,
    ...runtimeMacro,
  }
}
