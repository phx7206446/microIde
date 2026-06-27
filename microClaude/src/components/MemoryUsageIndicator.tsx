import * as React from 'react'
import { useMemoryUsage } from '../hooks/useMemoryUsage.js'
import { Box, Text } from '../ink.js'
import { formatFileSize } from '../utils/format.js'

export function MemoryUsageIndicator(): React.ReactNode {
  // Ant-only: /heapdump is an internal debugging aid. Gate before the hook so
  // external builds never start the polling interval.
  if (process.env.USER_TYPE !== 'ant') {
    return null
  }

  // eslint-disable-next-line react-hooks/rules-of-hooks
  // biome-ignore lint/correctness/useHookAtTopLevel: USER_TYPE is a compile-time constant
  const memoryUsage = useMemoryUsage()

  if (!memoryUsage) {
    return null
  }

  const { heapUsed, status } = memoryUsage
  if (status === 'normal') {
    return null
  }

  const formattedSize = formatFileSize(heapUsed)
  const color = status === 'critical' ? 'error' : 'warning'

  return (
    <Box>
      <Text color={color} wrap="truncate">
        High memory usage ({formattedSize}) | /heapdump
      </Text>
    </Box>
  )
}
