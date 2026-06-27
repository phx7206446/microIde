import { useEffect, useRef } from 'react'
import { TICK_TAG } from '../constants/xml.js'
import {
  getNextTickAt,
  isContextBlocked,
  isProactiveActive,
  isProactivePaused,
  setNextTickAt,
} from './index.js'

const DEFAULT_TICK_MS = 30_000

function getTickIntervalMs(): number {
  const fromEnv = parseInt(process.env.CLAUDE_CODE_PROACTIVE_TICK_MS || '', 10)
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_TICK_MS
}

function buildTickPrompt(): string {
  return `<${TICK_TAG}>${new Date().toLocaleTimeString()}</${TICK_TAG}>`
}

type UseProactiveOptions = {
  isLoading: boolean
  queuedCommandsLength: number
  hasActiveLocalJsxUI: boolean
  isInPlanMode: boolean
  onSubmitTick: (prompt: string) => void
  onQueueTick: (prompt: string) => void
}

export function useProactive({
  isLoading,
  queuedCommandsLength,
  hasActiveLocalJsxUI,
  isInPlanMode,
  onSubmitTick,
  onQueueTick,
}: UseProactiveOptions): void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const submitRef = useRef(onSubmitTick)
  const queueRef = useRef(onQueueTick)

  submitRef.current = onSubmitTick
  queueRef.current = onQueueTick

  useEffect(() => {
    const active = isProactiveActive()
    const paused = isProactivePaused()
    const contextBlocked = isContextBlocked()
    const shouldHideCountdown =
      !active ||
      paused ||
      contextBlocked ||
      isLoading ||
      queuedCommandsLength > 0 ||
      hasActiveLocalJsxUI ||
      isInPlanMode

    if (!active || paused || contextBlocked || hasActiveLocalJsxUI || isInPlanMode) {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      if (getNextTickAt() !== null) {
        setNextTickAt(null)
      }
      return
    }

    const nextTickAt = Date.now() + getTickIntervalMs()
    setNextTickAt(shouldHideCountdown ? null : nextTickAt)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      setNextTickAt(null)
      const prompt = buildTickPrompt()
      if (isLoading || queuedCommandsLength > 0) {
        queueRef.current(prompt)
        return
      }
      submitRef.current(prompt)
    }, Math.max(0, nextTickAt - Date.now()))

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      setNextTickAt(null)
    }
  }, [
    hasActiveLocalJsxUI,
    isInPlanMode,
    isLoading,
    onQueueTick,
    onSubmitTick,
    queuedCommandsLength,
  ])
}
