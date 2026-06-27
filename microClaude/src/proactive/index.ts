type ProactiveActivationSource = 'command' | 'system' | 'resume'

type ProactiveState = {
  active: boolean
  paused: boolean
  contextBlocked: boolean
  nextTickAt: number | null
  activationSource: ProactiveActivationSource | null
}

type Subscriber = () => void

const subscribers = new Set<Subscriber>()

let state: ProactiveState = {
  active: false,
  paused: false,
  contextBlocked: false,
  nextTickAt: null,
  activationSource: null,
}

function emitIfChanged(next: ProactiveState): void {
  if (
    next.active === state.active &&
    next.paused === state.paused &&
    next.contextBlocked === state.contextBlocked &&
    next.nextTickAt === state.nextTickAt &&
    next.activationSource === state.activationSource
  ) {
    return
  }
  state = next
  for (const subscriber of subscribers) {
    subscriber()
  }
}

function patchState(
  updater: (prev: Readonly<ProactiveState>) => ProactiveState,
): void {
  emitIfChanged(updater(state))
}

export function isProactiveActive(): boolean {
  return state.active
}

export function activateProactive(
  source: ProactiveActivationSource = 'command',
): void {
  patchState(prev => ({
    ...prev,
    active: true,
    paused: false,
    contextBlocked: false,
    activationSource: source,
  }))
}

export function deactivateProactive(): void {
  patchState(_prev => ({
    active: false,
    paused: false,
    contextBlocked: false,
    nextTickAt: null,
    activationSource: null,
  }))
}

export function isProactivePaused(): boolean {
  return state.paused
}

export function pauseProactive(): void {
  patchState(prev =>
    prev.active
      ? {
          ...prev,
          paused: true,
          nextTickAt: null,
        }
      : prev,
  )
}

export function resumeProactive(): void {
  patchState(prev =>
    prev.active
      ? {
          ...prev,
          paused: false,
        }
      : prev,
  )
}

export function setContextBlocked(blocked: boolean): void {
  patchState(prev => ({
    ...prev,
    contextBlocked: blocked,
    nextTickAt: blocked ? null : prev.nextTickAt,
  }))
}

export function isContextBlocked(): boolean {
  return state.contextBlocked
}

export function setNextTickAt(nextTickAt: number | null): void {
  patchState(prev => ({
    ...prev,
    nextTickAt,
  }))
}

export function getNextTickAt(): number | null {
  return state.nextTickAt
}

export function subscribeToProactiveChanges(cb: Subscriber): () => void {
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}
