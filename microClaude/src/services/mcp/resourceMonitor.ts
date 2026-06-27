import {
  EmptyResultSchema,
  type ReadResourceResult,
  ReadResourceResultSchema,
  ResourceUpdatedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js'
import {
  OUTPUT_FILE_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
  TOOL_USE_ID_TAG,
} from '../../constants/xml.js'
import type { SetAppState } from '../../Task.js'
import {
  completeMonitorMcp,
  registerMonitorMcpTask,
} from '../../tasks/MonitorMcpTask/MonitorMcpTask.js'
import type { AgentId } from '../../types/ids.js'
import { errorMessage } from '../../utils/errors.js'
import { logMCPDebug, logMCPError } from '../../utils/log.js'
import { enqueuePendingNotification } from '../../utils/messageQueueManager.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  appendTaskOutput,
  getTaskOutputPath,
  initTaskOutput,
} from '../../utils/task/diskOutput.js'
import { escapeXml } from '../../utils/xml.js'
import { ensureConnectedClient } from './client.js'
import {
  materializeReadResourceResult,
  type MaterializedResourceContent,
} from './resourceContent.js'
import type { ConnectedMCPServer, MCPServerConnection } from './types.js'

const MAX_MONITOR_SUMMARY_LENGTH = 400
const MAX_MONITOR_DESCRIPTION_LENGTH = 120

type MonitorEntry = {
  taskId: string
  description: string
  serverName: string
  resourceUri: string
  setAppState: SetAppState
  toolUseId?: string
  agentId?: AgentId
}

const entriesByTaskId = new Map<string, MonitorEntry>()
const taskIdsByServer = new Map<string, Set<string>>()
const uriRefCountsByServer = new Map<string, Map<string, number>>()
const activeClientsByServer = new Map<string, ConnectedMCPServer>()
const readChainsByResource = new Map<string, Promise<void>>()
const pendingReadsByResource = new Set<string>()

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text
  }
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`
}

function firstMeaningfulLine(text: string | undefined): string | null {
  if (!text) {
    return null
  }

  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const trimmed = line.trim()
    if (trimmed !== '') {
      return trimmed
    }
  }

  return null
}

function summarizeContents(
  contents: MaterializedResourceContent[],
  resourceUri: string,
): string {
  for (const content of contents) {
    const firstLine = firstMeaningfulLine(content.text)
    if (firstLine) {
      return firstLine
    }
    if (content.blobSavedTo) {
      return `Binary content saved to ${content.blobSavedTo}`
    }
  }

  return `Resource ${resourceUri} updated`
}

function buildNotificationSummary(
  description: string,
  resourceSummary: string,
): string {
  return `Monitor "${truncate(
    description,
    MAX_MONITOR_DESCRIPTION_LENGTH,
  )}": ${truncate(resourceSummary, MAX_MONITOR_SUMMARY_LENGTH)}`
}

function formatSnapshotBlock(params: {
  label: string
  serverName: string
  resourceUri: string
  contents: MaterializedResourceContent[]
}): string {
  return `[${new Date().toISOString()}] ${params.label}\n${jsonStringify(
    {
      server: params.serverName,
      uri: params.resourceUri,
      contents: params.contents,
    },
    null,
    2,
  )}\n\n`
}

function formatErrorBlock(params: {
  label: string
  serverName: string
  resourceUri: string
  error: string
}): string {
  return `[${new Date().toISOString()}] ${params.label}\n${params.serverName} ${params.resourceUri}\n${params.error}\n\n`
}

function getResourceKey(serverName: string, resourceUri: string): string {
  return `${serverName}\n${resourceUri}`
}

function getEntriesForServer(serverName: string): MonitorEntry[] {
  const taskIds = taskIdsByServer.get(serverName)
  if (!taskIds) {
    return []
  }

  const entries: MonitorEntry[] = []
  for (const taskId of taskIds) {
    const entry = entriesByTaskId.get(taskId)
    if (entry) {
      entries.push(entry)
    }
  }
  return entries
}

function getEntriesForResource(
  serverName: string,
  resourceUri: string,
): MonitorEntry[] {
  return getEntriesForServer(serverName).filter(
    entry => entry.resourceUri === resourceUri,
  )
}

function registerEntry(entry: MonitorEntry): { firstSubscriber: boolean } {
  entriesByTaskId.set(entry.taskId, entry)

  let serverTaskIds = taskIdsByServer.get(entry.serverName)
  if (!serverTaskIds) {
    serverTaskIds = new Set()
    taskIdsByServer.set(entry.serverName, serverTaskIds)
  }
  serverTaskIds.add(entry.taskId)

  let uriCounts = uriRefCountsByServer.get(entry.serverName)
  if (!uriCounts) {
    uriCounts = new Map()
    uriRefCountsByServer.set(entry.serverName, uriCounts)
  }

  const previousCount = uriCounts.get(entry.resourceUri) ?? 0
  uriCounts.set(entry.resourceUri, previousCount + 1)

  return {
    firstSubscriber: previousCount === 0,
  }
}

async function removeEntry(
  taskId: string,
  options: { unsubscribe: boolean },
): Promise<MonitorEntry | undefined> {
  const entry = entriesByTaskId.get(taskId)
  if (!entry) {
    return undefined
  }

  entriesByTaskId.delete(taskId)

  const serverTaskIds = taskIdsByServer.get(entry.serverName)
  serverTaskIds?.delete(taskId)
  if (serverTaskIds?.size === 0) {
    taskIdsByServer.delete(entry.serverName)
    activeClientsByServer.delete(entry.serverName)
  }

  const uriCounts = uriRefCountsByServer.get(entry.serverName)
  const previousCount = uriCounts?.get(entry.resourceUri) ?? 0
  const nextCount = Math.max(0, previousCount - 1)
  if (uriCounts) {
    if (nextCount === 0) {
      uriCounts.delete(entry.resourceUri)
    } else {
      uriCounts.set(entry.resourceUri, nextCount)
    }
    if (uriCounts.size === 0) {
      uriRefCountsByServer.delete(entry.serverName)
    }
  }

  if (options.unsubscribe && previousCount === 1) {
    await unsubscribeResource(entry.serverName, entry.resourceUri)
  }

  return entry
}

async function getActiveClient(serverName: string): Promise<ConnectedMCPServer> {
  const currentClient = activeClientsByServer.get(serverName)
  if (!currentClient) {
    throw new Error(`No connected MCP client available for "${serverName}"`)
  }

  const connectedClient = await ensureConnectedClient(currentClient)
  if (connectedClient !== currentClient) {
    installResourceUpdatedHandler(connectedClient)
  }
  return connectedClient
}

async function subscribeResource(
  serverName: string,
  resourceUri: string,
): Promise<void> {
  const client = await getActiveClient(serverName)
  await client.client.request(
    {
      method: 'resources/subscribe',
      params: { uri: resourceUri },
    },
    EmptyResultSchema,
  )
  logMCPDebug(serverName, `Subscribed to resource updates for ${resourceUri}`)
}

async function unsubscribeResource(
  serverName: string,
  resourceUri: string,
): Promise<void> {
  const currentClient = activeClientsByServer.get(serverName)
  if (!currentClient) {
    return
  }

  try {
    const client = await ensureConnectedClient(currentClient)
    if (client !== currentClient) {
      installResourceUpdatedHandler(client)
    }
    await client.client.request(
      {
        method: 'resources/unsubscribe',
        params: { uri: resourceUri },
      },
      EmptyResultSchema,
    )
    logMCPDebug(
      serverName,
      `Unsubscribed from resource updates for ${resourceUri}`,
    )
  } catch (error) {
    logMCPError(
      serverName,
      `Failed to unsubscribe ${resourceUri}: ${errorMessage(error)}`,
    )
  }
}

async function readMaterializedContents(
  serverName: string,
  resourceUri: string,
): Promise<MaterializedResourceContent[]> {
  const client = await getActiveClient(serverName)
  const result = (await client.client.request(
    {
      method: 'resources/read',
      params: { uri: resourceUri },
    },
    ReadResourceResultSchema,
  )) as ReadResourceResult

  return materializeReadResourceResult({
    serverName,
    result,
    messagePrefix: `[Monitor update from ${serverName} at ${resourceUri}] `,
    persistPrefix: 'mcp-monitor',
  })
}

function enqueueUpdateNotification(
  entry: MonitorEntry,
  resourceSummary: string,
): void {
  const toolUseIdLine = entry.toolUseId
    ? `\n<${TOOL_USE_ID_TAG}>${entry.toolUseId}</${TOOL_USE_ID_TAG}>`
    : ''
  const message = `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${entry.taskId}</${TASK_ID_TAG}>${toolUseIdLine}
<${OUTPUT_FILE_TAG}>${getTaskOutputPath(entry.taskId)}</${OUTPUT_FILE_TAG}>
<${SUMMARY_TAG}>${escapeXml(
    buildNotificationSummary(entry.description, resourceSummary),
  )}</${SUMMARY_TAG}>
</${TASK_NOTIFICATION_TAG}>`

  enqueuePendingNotification({
    value: message,
    mode: 'task-notification',
    priority: 'next',
    agentId: entry.agentId,
  })
}

async function captureSnapshot(params: {
  serverName: string
  resourceUri: string
  entries: MonitorEntry[]
  label: string
  notify: boolean
}): Promise<void> {
  if (params.entries.length === 0) {
    return
  }

  const contents = await readMaterializedContents(
    params.serverName,
    params.resourceUri,
  )
  const snapshot = formatSnapshotBlock({
    label: params.label,
    serverName: params.serverName,
    resourceUri: params.resourceUri,
    contents,
  })

  for (const entry of params.entries) {
    appendTaskOutput(entry.taskId, snapshot)
  }

  if (!params.notify) {
    return
  }

  const resourceSummary = summarizeContents(contents, params.resourceUri)
  for (const entry of params.entries) {
    enqueueUpdateNotification(entry, resourceSummary)
  }
}

async function recordReadFailure(
  entries: MonitorEntry[],
  params: {
    serverName: string
    resourceUri: string
    label: string
    error: string
  },
): Promise<void> {
  if (entries.length === 0) {
    return
  }

  const output = formatErrorBlock({
    label: params.label,
    serverName: params.serverName,
    resourceUri: params.resourceUri,
    error: params.error,
  })

  for (const entry of entries) {
    appendTaskOutput(entry.taskId, output)
    enqueueUpdateNotification(entry, `Failed to read update: ${params.error}`)
  }
}

async function processResourceUpdate(
  serverName: string,
  resourceUri: string,
): Promise<void> {
  const entries = getEntriesForResource(serverName, resourceUri)
  if (entries.length === 0) {
    return
  }

  try {
    await captureSnapshot({
      serverName,
      resourceUri,
      entries,
      label: 'Resource update',
      notify: true,
    })
  } catch (error) {
    const message = errorMessage(error)
    logMCPError(
      serverName,
      `Failed to read updated resource ${resourceUri}: ${message}`,
    )
    await recordReadFailure(entries, {
      serverName,
      resourceUri,
      label: 'Resource update read failed',
      error: message,
    })
  }
}

function queueResourceUpdate(serverName: string, resourceUri: string): void {
  const key = getResourceKey(serverName, resourceUri)
  if (readChainsByResource.has(key)) {
    pendingReadsByResource.add(key)
    return
  }

  const next = (async () => {
    try {
      do {
        pendingReadsByResource.delete(key)
        await processResourceUpdate(serverName, resourceUri)
      } while (pendingReadsByResource.delete(key))
    } finally {
      pendingReadsByResource.delete(key)
      if (readChainsByResource.get(key) === next) {
        readChainsByResource.delete(key)
      }
    }
  })()

  readChainsByResource.set(key, next)
}

function installResourceUpdatedHandler(client: ConnectedMCPServer): void {
  activeClientsByServer.set(client.name, client)
  client.client.setNotificationHandler(
    ResourceUpdatedNotificationSchema,
    notification => {
      const resourceUri = notification.params.uri
      logMCPDebug(
        client.name,
        `Received notifications/resources/updated for ${resourceUri}`,
      )
      queueResourceUpdate(client.name, resourceUri)
    },
  )
}

async function failEntries(
  entries: MonitorEntry[],
  reason: string,
): Promise<void> {
  await Promise.all(
    entries.map(async entry => {
      await removeEntry(entry.taskId, { unsubscribe: false })
      appendTaskOutput(
        entry.taskId,
        formatErrorBlock({
          label: 'Monitor failed',
          serverName: entry.serverName,
          resourceUri: entry.resourceUri,
          error: reason,
        }),
      )
      completeMonitorMcp(entry.taskId, entry.setAppState, {
        status: 'failed',
        reason,
      })
    }),
  )
}

export async function startMcpResourceMonitor(params: {
  client: ConnectedMCPServer
  description: string
  serverName: string
  resourceUri: string
  setAppState: SetAppState
  toolUseId?: string
  agentId?: AgentId
}): Promise<{ taskId: string; outputFile: string }> {
  const connectedClient = await ensureConnectedClient(params.client)
  installResourceUpdatedHandler(connectedClient)

  let taskId = ''
  const handle = registerMonitorMcpTask(
    {
      description: params.description,
      command: `mcp://${params.serverName}/${params.resourceUri}`,
      serverName: params.serverName,
      resourceUri: params.resourceUri,
      toolUseId: params.toolUseId,
      agentId: params.agentId,
      stop: async () => {
        if (taskId !== '') {
          await stopMcpResourceMonitor(taskId)
        }
      },
    },
    params.setAppState,
  )
  taskId = handle.taskId

  await initTaskOutput(taskId)
  const entry: MonitorEntry = {
    taskId,
    description: params.description,
    serverName: params.serverName,
    resourceUri: params.resourceUri,
    setAppState: params.setAppState,
    toolUseId: params.toolUseId,
    agentId: params.agentId,
  }

  const { firstSubscriber } = registerEntry(entry)

  try {
    if (firstSubscriber) {
      await subscribeResource(params.serverName, params.resourceUri)
    }
  } catch (error) {
    await removeEntry(taskId, { unsubscribe: false })
    const message = errorMessage(error)
    completeMonitorMcp(taskId, params.setAppState, {
      status: 'failed',
      reason: `Failed to subscribe: ${message}`,
    })
    throw new Error(
      `Failed to subscribe to ${params.serverName} resource ${params.resourceUri}: ${message}`,
    )
  }

  try {
    await captureSnapshot({
      serverName: params.serverName,
      resourceUri: params.resourceUri,
      entries: [entry],
      label: 'Initial snapshot',
      notify: false,
    })
  } catch (error) {
    const message = errorMessage(error)
    logMCPError(
      params.serverName,
      `Initial read for ${params.resourceUri} failed: ${message}`,
    )
    appendTaskOutput(
      taskId,
      formatErrorBlock({
        label: 'Initial snapshot failed',
        serverName: params.serverName,
        resourceUri: params.resourceUri,
        error: message,
      }),
    )
  }

  return { taskId, outputFile: getTaskOutputPath(taskId) }
}

export async function stopMcpResourceMonitor(taskId: string): Promise<void> {
  await removeEntry(taskId, { unsubscribe: true })
}

export function reattachMcpResourceMonitors(
  connection: MCPServerConnection,
): void {
  if (connection.type !== 'connected') {
    return
  }

  const entries = getEntriesForServer(connection.name)
  if (entries.length === 0) {
    return
  }

  installResourceUpdatedHandler(connection)

  const uniqueUris = [...new Set(entries.map(entry => entry.resourceUri))]
  void Promise.allSettled(
    uniqueUris.map(async resourceUri => {
      try {
        await subscribeResource(connection.name, resourceUri)

        const entriesForResource = getEntriesForResource(
          connection.name,
          resourceUri,
        )
        if (entriesForResource.length === 0) {
          return
        }

        try {
          await captureSnapshot({
            serverName: connection.name,
            resourceUri,
            entries: entriesForResource,
            label: 'Snapshot after reconnect',
            notify: true,
          })
        } catch (error) {
          const message = errorMessage(error)
          logMCPError(
            connection.name,
            `Failed to capture reconnect snapshot for ${resourceUri}: ${message}`,
          )
          await recordReadFailure(entriesForResource, {
            serverName: connection.name,
            resourceUri,
            label: 'Snapshot after reconnect failed',
            error: message,
          })
        }
      } catch (error) {
        const message = errorMessage(error)
        logMCPError(
          connection.name,
          `Failed to reattach resource monitor for ${resourceUri}: ${message}`,
        )
        await failEntries(
          getEntriesForResource(connection.name, resourceUri),
          `Failed to reattach MCP monitor after reconnect: ${message}`,
        )
      }
    }),
  )
}

export function failMcpResourceMonitorsForServer(
  serverName: string,
  reason: string,
): void {
  const entries = getEntriesForServer(serverName)
  if (entries.length === 0) {
    return
  }

  void failEntries(entries, reason)
}
