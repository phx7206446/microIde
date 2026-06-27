import * as React from 'react'
import { useEffect, useState } from 'react'
import { Text } from '../../ink.js'
import { formatDuration } from '../../utils/format.js'

type Props = {
  startedAt: number
}

export function GoalActiveIndicator({ startedAt }: Props): React.ReactNode {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const update = () => setNow(Date.now())
    update()
    const interval = setInterval(update, 1000)
    return () => clearInterval(interval)
  }, [startedAt])

  const duration = formatDuration(Math.max(0, now - startedAt), {
    mostSignificantOnly: true,
  })

  return (
    <Text color="suggestion">
      ◎ /goal active <Text dimColor>{duration}</Text>
    </Text>
  )
}
