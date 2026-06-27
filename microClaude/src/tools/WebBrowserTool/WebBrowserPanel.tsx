import React from 'react'
import { Box, Text } from '../../ink.js'
import { useAppState } from '../../state/AppState.js'

export function WebBrowserPanel(): React.ReactElement | null {
  const isActive = useAppState(state => state.bagelActive === true)
  const isVisible = useAppState(state => state.bagelPanelVisible !== false)
  const url = useAppState(state => state.bagelUrl)

  if (!isActive || !isVisible) {
    return null
  }

  return (
    <Box
      borderStyle="round"
      borderColor="border"
      flexDirection="column"
      marginTop={1}
      paddingX={1}
    >
      <Text bold>Web Browser</Text>
      <Text dimColor>{url ?? 'No active page'}</Text>
    </Box>
  )
}
