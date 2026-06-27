import * as React from 'react'
import {
  getHistorySearchScopeLabel,
  getNextHistorySearchScope,
  type HistorySearchScope,
} from '../../history.js'
import { Box, Text } from '../../ink.js'
import { stringWidth } from '../../ink/stringWidth.js'
import TextInput from '../TextInput.js'

type Props = {
  value: string
  onChange: (value: string) => void
  historyScope: HistorySearchScope
  historyFailedMatch: boolean
}

function HistorySearchInput({
  value,
  onChange,
  historyScope,
  historyFailedMatch,
}: Props): React.ReactNode {
  const prefix = historyFailedMatch
    ? 'no matching prompt:'
    : `search prompts (${getHistorySearchScopeLabel(historyScope)}):`

  return (
    <Box gap={1}>
      <Text dimColor>{prefix}</Text>
      <TextInput
        value={value}
        onChange={onChange}
        // Force cursor to end of search input since navigation should cancel search.
        cursorOffset={value.length}
        onChangeCursorOffset={() => {}}
        columns={stringWidth(value) + 1}
        focus={true}
        showCursor={true}
        multiline={false}
        dimColor={true}
      />
      <Text dimColor>
        Ctrl+S{' '}
        {getHistorySearchScopeLabel(getNextHistorySearchScope(historyScope))}
      </Text>
    </Box>
  )
}

export default HistorySearchInput
