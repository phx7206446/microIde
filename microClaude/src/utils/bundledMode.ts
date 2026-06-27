/**
 * Detects if the current runtime is Bun.
 * Returns true when:
 * - Running a JS file via the `bun` command
 * - Running a Bun-compiled standalone executable
 */
export function isRunningWithBun(): boolean {
  // https://bun.com/guides/util/detect-bun
  return process.versions.bun !== undefined
}

/**
 * Detects if running as a Bun-compiled standalone executable.
 * This checks for embedded files which are present in compiled binaries.
 */
export function isInBundledMode(): boolean {
  const bunRuntime = (
    globalThis as typeof globalThis & {
      Bun?: typeof Bun & {
        embeddedFiles?: unknown[]
      }
    }
  ).Bun
  return Array.isArray(bunRuntime?.embeddedFiles) && bunRuntime.embeddedFiles.length > 0
}
