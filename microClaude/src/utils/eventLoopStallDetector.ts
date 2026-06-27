import { logForDebugging } from './debug.js'

const CHECK_INTERVAL_MS = 100
const STALL_THRESHOLD_MS = 500

let intervalHandle: ReturnType<typeof setInterval> | null = null

export function startEventLoopStallDetector(): void {
  if (intervalHandle) {
    return
  }

  let expected = Date.now() + CHECK_INTERVAL_MS

  intervalHandle = setInterval(() => {
    const now = Date.now()
    const delayMs = now - expected
    expected = now + CHECK_INTERVAL_MS

    if (delayMs <= STALL_THRESHOLD_MS) {
      return
    }

    logForDebugging(
      `[event-loop] Main thread stalled for ${Math.round(delayMs)}ms`,
      { level: 'warn' },
    )
  }, CHECK_INTERVAL_MS)

  intervalHandle.unref()
}
