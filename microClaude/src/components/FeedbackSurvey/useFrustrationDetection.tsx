import { randomUUID } from 'crypto'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useDynamicConfig } from 'src/hooks/useDynamicConfig.js'
import { isFeedbackSurveyDisabled } from 'src/services/analytics/config.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { isPolicyAllowed } from '../../services/policyLimits/index.js'
import type { Message } from '../../types/message.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { getUserMessageText } from '../../utils/messages.js'
import { logOTelEvent } from '../../utils/telemetry/events.js'
import { matchesNegativeKeyword } from '../../utils/userPromptKeywords.js'
import { submitTranscriptShare } from './submitTranscriptShare.js'
import type { TranscriptShareResponse } from './TranscriptSharePrompt.js'

type FrustrationDetectionConfig = {
  enabled: boolean
  probability: number
  hideThanksAfterMs: number
}

type FrustrationSurveyState =
  | 'closed'
  | 'thanks'
  | 'transcript_prompt'
  | 'submitting'
  | 'submitted'

type FrustrationCandidate = {
  uuid: string
  text: string
}

const DEFAULT_CONFIG: FrustrationDetectionConfig = {
  enabled: true,
  probability: 0.2,
  hideThanksAfterMs: 3000,
}

const EXTRA_FRUSTRATION_PATTERNS = [
  /\b(?:this|it|that)(?:'s| is)? (?:still )?(?:broken|buggy|useless|garbage)\b/i,
  /\b(?:is|are) (?:still )?(?:broken|buggy|useless)\b/i,
  /\b(?:not|isn't|is not|still not) working\b/i,
  /\bi give up\b/i,
  /\bwhy (?:is|are) (?:this|it|you)\b/i,
]

const FRUSTRATION_EVENT = 'tengu_frustration_detection_event'
const FRUSTRATION_SURVEY_TYPE = 'frustration'

function isFrustratedText(text: string): boolean {
  return (
    matchesNegativeKeyword(text) ||
    EXTRA_FRUSTRATION_PATTERNS.some(pattern => pattern.test(text))
  )
}

export function useFrustrationDetection(
  messages: Message[],
  isLoading: boolean,
  hasActivePrompt = false,
  hasOtherSurveyOpen = false,
): {
  state: FrustrationSurveyState
  handleTranscriptSelect: (selected: TranscriptShareResponse) => void
} {
  const config = useDynamicConfig<FrustrationDetectionConfig>(
    'tengu_frustration_transcript_ask_config',
    DEFAULT_CONFIG,
  )
  const [state, setState] = useState<FrustrationSurveyState>('closed')
  const appearanceIdRef = useRef(randomUUID())
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const messagesRef = useRef(messages)
  const triggeredMessageUuidRef = useRef<string | null>(null)
  const evaluatedUserMessageUuids = useRef<Set<string>>(new Set())
  messagesRef.current = messages

  const userMessages = useMemo(
    () =>
      messages.filter((message): message is Extract<Message, { type: 'user' }> =>
        message.type === 'user',
      ),
    [messages],
  )

  const latestFrustration = useMemo<FrustrationCandidate | null>(() => {
    for (let i = userMessages.length - 1; i >= 0; i--) {
      const message = userMessages[i]!
      const text = getUserMessageText(message)?.trim()
      if (!text) {
        continue
      }
      if (isFrustratedText(text)) {
        return {
          uuid: message.uuid,
          text,
        }
      }
    }
    return null
  }, [userMessages])

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }, [])

  const scheduleClose = useCallback(
    (nextState: 'closed') => {
      clearCloseTimer()
      closeTimerRef.current = setTimeout(() => {
        closeTimerRef.current = null
        triggeredMessageUuidRef.current = null
        setState(nextState)
      }, config.hideThanksAfterMs)
    },
    [clearCloseTimer, config.hideThanksAfterMs],
  )

  const showThanksThenClose = useCallback(() => {
    setState('thanks')
    scheduleClose('closed')
  }, [scheduleClose])

  const showSubmittedThenClose = useCallback(() => {
    setState('submitted')
    scheduleClose('closed')
  }, [scheduleClose])

  useEffect(() => clearCloseTimer, [clearCloseTimer])

  useEffect(() => {
    if (messages.length !== 0) {
      return
    }
    clearCloseTimer()
    evaluatedUserMessageUuids.current.clear()
    triggeredMessageUuidRef.current = null
    setState('closed')
  }, [clearCloseTimer, messages.length])

  useEffect(() => {
    if (process.env.USER_TYPE !== 'ant') {
      return
    }
    if (state !== 'closed' || isLoading || hasActivePrompt || hasOtherSurveyOpen) {
      return
    }
    if (!config.enabled || config.probability <= 0) {
      return
    }
    if (isFeedbackSurveyDisabled()) {
      return
    }
    if (!isPolicyAllowed('allow_product_feedback')) {
      return
    }
    if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY)) {
      return
    }
    if (getGlobalConfig().transcriptShareDismissed) {
      return
    }
    if (!latestFrustration) {
      return
    }
    if (evaluatedUserMessageUuids.current.has(latestFrustration.uuid)) {
      return
    }

    evaluatedUserMessageUuids.current.add(latestFrustration.uuid)
    if (Math.random() > config.probability) {
      return
    }

    appearanceIdRef.current = randomUUID()
    triggeredMessageUuidRef.current = latestFrustration.uuid
    setState('transcript_prompt')

    logEvent(FRUSTRATION_EVENT, {
      event_type:
        'transcript_prompt_appeared' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      appearance_id:
        appearanceIdRef.current as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      trigger:
        'frustration' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      user_message_uuid:
        latestFrustration.uuid as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    void logOTelEvent('feedback_survey', {
      event_type: 'transcript_prompt_appeared',
      appearance_id: appearanceIdRef.current,
      survey_type: FRUSTRATION_SURVEY_TYPE,
    })
  }, [
    config.enabled,
    config.probability,
    hasActivePrompt,
    hasOtherSurveyOpen,
    isLoading,
    latestFrustration,
    state,
  ])

  const handleTranscriptSelect = useCallback(
    (selected: TranscriptShareResponse) => {
      if (process.env.USER_TYPE !== 'ant') {
        return
      }

      logEvent(FRUSTRATION_EVENT, {
        event_type:
          `transcript_share_${selected}` as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        appearance_id:
          appearanceIdRef.current as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        trigger:
          'frustration' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })

      if (selected === 'dont_ask_again') {
        saveGlobalConfig(current => ({
          ...current,
          transcriptShareDismissed: true,
        }))
      }

      if (selected !== 'yes') {
        showThanksThenClose()
        return
      }

      setState('submitting')
      void (async () => {
        try {
          const result = await submitTranscriptShare(
            messagesRef.current,
            'frustration',
            appearanceIdRef.current,
          )
          logEvent(FRUSTRATION_EVENT, {
            event_type:
              (result.success
                ? 'transcript_share_submitted'
                : 'transcript_share_failed') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            appearance_id:
              appearanceIdRef.current as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            trigger:
              'frustration' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          })
          if (result.success) {
            showSubmittedThenClose()
          } else {
            showThanksThenClose()
          }
        } catch {
          showThanksThenClose()
        }
      })()
    },
    [showSubmittedThenClose, showThanksThenClose],
  )

  return {
    state,
    handleTranscriptSelect,
  }
}
