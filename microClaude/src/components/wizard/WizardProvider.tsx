import React, {
  createContext,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js'
import type { WizardContextValue, WizardProviderProps } from './types.js'

// Use any here for the context since it will be cast properly when used.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const WizardContext = createContext<WizardContextValue<any> | null>(null)

export function WizardProvider<T extends Record<string, unknown>>({
  steps,
  initialData = {} as T,
  onComplete,
  onCancel,
  children,
  title,
  showStepCounter = true,
}: WizardProviderProps<T>): ReactNode {
  const [currentStepIndex, setCurrentStepIndex] = useState(0)
  const [wizardData, setWizardData] = useState<T>(initialData)
  const [isCompleted, setIsCompleted] = useState(false)
  const [navigationHistory, setNavigationHistory] = useState<number[]>([])

  useExitOnCtrlCDWithKeybindings()

  // Handle completion in effect to avoid updating the parent during render.
  useEffect(() => {
    if (isCompleted) {
      setNavigationHistory([])
      void onComplete(wizardData)
    }
  }, [isCompleted, wizardData, onComplete])

  const goNext = useCallback(() => {
    if (currentStepIndex < steps.length - 1) {
      // Preserve custom navigation flows when a step jumped elsewhere.
      if (navigationHistory.length > 0) {
        setNavigationHistory(prev => [...prev, currentStepIndex])
      }
      setCurrentStepIndex(prev => prev + 1)
      return
    }

    setIsCompleted(true)
  }, [currentStepIndex, steps.length, navigationHistory])

  const goBack = useCallback(() => {
    if (navigationHistory.length > 0) {
      const previousStep = navigationHistory[navigationHistory.length - 1]
      if (previousStep !== undefined) {
        setNavigationHistory(prev => prev.slice(0, -1))
        setCurrentStepIndex(previousStep)
      }
      return
    }

    if (currentStepIndex > 0) {
      setCurrentStepIndex(prev => prev - 1)
      return
    }

    onCancel?.()
  }, [currentStepIndex, navigationHistory, onCancel])

  const goToStep = useCallback(
    (index: number) => {
      if (index >= 0 && index < steps.length) {
        setNavigationHistory(prev => [...prev, currentStepIndex])
        setCurrentStepIndex(index)
      }
    },
    [currentStepIndex, steps.length],
  )

  const cancel = useCallback(() => {
    setNavigationHistory([])
    onCancel?.()
  }, [onCancel])

  const updateWizardData = useCallback((updates: Partial<T>) => {
    setWizardData(prev => ({ ...prev, ...updates }))
  }, [])

  const contextValue = useMemo<WizardContextValue<T>>(
    () => ({
      currentStepIndex,
      totalSteps: steps.length,
      wizardData,
      setWizardData,
      updateWizardData,
      goNext,
      goBack,
      goToStep,
      cancel,
      title,
      showStepCounter,
    }),
    [
      currentStepIndex,
      steps.length,
      wizardData,
      updateWizardData,
      goNext,
      goBack,
      goToStep,
      cancel,
      title,
      showStepCounter,
    ],
  )

  const CurrentStepComponent = steps[currentStepIndex]
  if (!CurrentStepComponent || isCompleted) {
    return null
  }

  return (
    <WizardContext.Provider value={contextValue}>
      {children || <CurrentStepComponent />}
    </WizardContext.Provider>
  )
}
