import * as React from 'react'
import { Text } from '../ink.js'
import type { EffortLevel } from '../utils/effort.js'
import { effortLevelToSymbol } from './EffortIndicator.js'

export function EffortIndicatorSymbol({
  level,
}: {
  level: EffortLevel
}): React.ReactNode {
  return <Text color="suggestion">{effortLevelToSymbol(level)}</Text>
}
