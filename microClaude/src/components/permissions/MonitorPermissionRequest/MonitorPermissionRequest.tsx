import * as React from 'react'
import { Box, Text } from '../../../ink.js'
import { SimpleToolPermissionRequest } from '../SimpleToolPermissionRequest.js'
import type { PermissionRequestProps } from '../PermissionRequest.js'

function getStringField(
  input: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value.trim() !== '') {
      return value
    }
  }
  return undefined
}

export function MonitorPermissionRequest(
  props: PermissionRequestProps,
): React.ReactNode {
  const input = props.toolUseConfirm.input as Record<string, unknown>
  const command = getStringField(input, 'command')
  const serverName = getStringField(input, 'serverName', 'server_name')
  const resourceUri = getStringField(input, 'resourceUri', 'resource_uri')
  const description =
    props.toolUseConfirm.description.trim() === ''
      ? undefined
      : props.toolUseConfirm.description

  const detailNode =
    command || serverName || resourceUri || description ? (
      <Box flexDirection="column">
        {command ? <Text>{command}</Text> : null}
        {serverName ? <Text dimColor>{`Server: ${serverName}`}</Text> : null}
        {resourceUri ? (
          <Text dimColor>{`Resource: ${resourceUri}`}</Text>
        ) : null}
        {!command && description ? <Text dimColor>{description}</Text> : null}
      </Box>
    ) : undefined

  return (
    <SimpleToolPermissionRequest
      {...props}
      title="Start monitor"
      question="Do you want Claude to start this monitor?"
      description={detailNode}
      acceptLabel="Start monitor"
      rejectLabel="Don't start it"
    />
  )
}
