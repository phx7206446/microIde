import { performHeapDump } from './heapDumpService.js'
import { logForDebugging } from './debug.js'

const RSS_THRESHOLD_BYTES = Math.floor(1.5 * 1024 * 1024 * 1024)
const CHECK_INTERVAL_MS = 60_000
const COOLDOWN_MS = 15 * 60_000
const MAX_AUTO_DUMPS = 3

let intervalHandle: ReturnType<typeof setInterval> | null = null
let dumpCount = 0
let dumpInFlight = false
let lastDumpAt = 0

function formatGiB(bytes: number): string {
  return (bytes / 1024 / 1024 / 1024).toFixed(3)
}

async function maybeDumpHeap(): Promise<void> {
  if (dumpInFlight || dumpCount >= MAX_AUTO_DUMPS) {
    return
  }

  const rss = process.memoryUsage().rss
  if (rss < RSS_THRESHOLD_BYTES) {
    return
  }

  const now = Date.now()
  if (now - lastDumpAt < COOLDOWN_MS) {
    return
  }

  dumpInFlight = true
  dumpCount += 1
  lastDumpAt = now

  logForDebugging(
    `[sdk-heap] RSS ${formatGiB(rss)} GiB exceeds ${(RSS_THRESHOLD_BYTES / 1024 / 1024 / 1024).toFixed(1)} GiB; capturing heap dump #${dumpCount}`,
    { level: 'warn' },
  )

  try {
    const result = await performHeapDump('auto-1.5GB', dumpCount)
    if (!result.success) {
      logForDebugging(
        `[sdk-heap] Auto heap dump #${dumpCount} failed: ${result.error ?? 'unknown error'}`,
        { level: 'error' },
      )
    }
  } finally {
    dumpInFlight = false
  }
}

export function startSdkMemoryMonitor(): void {
  if (intervalHandle) {
    return
  }

  intervalHandle = setInterval(() => {
    void maybeDumpHeap()
  }, CHECK_INTERVAL_MS)
  intervalHandle.unref()

  void maybeDumpHeap()
}
