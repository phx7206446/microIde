import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js'
import type { SystemSnipBoundaryMessage } from '../../types/message.js'
import { formatTokens } from '../../utils/format.js'

type Props = {
  message: SystemSnipBoundaryMessage
}

export function SnipBoundaryMessage({
  message,
}: Props): React.ReactNode {
  const historyShortcut = useShortcutDisplay(
    'app:toggleTranscript',
    'Global',
    'ctrl+o',
  )
  const turnCount = message.snipMetadata.removedMessageIds.length
  const tokensFreed = message.snipMetadata.tokensFreed
  const savedText =
    typeof tokensFreed === 'number' && tokensFreed > 0
      ? `, saved ~${formatTokens(tokensFreed)}`
      : ''

  return (
    <Box marginY={1}>
      <Text dimColor>
        Context trimmed ({turnCount} turn{turnCount === 1 ? '' : 's'}
        {savedText}; {historyShortcut} for history)
      </Text>
    </Box>
  )
}
