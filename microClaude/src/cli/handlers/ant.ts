import { readFile, writeFile } from 'fs/promises'
import { extname, resolve } from 'path'
import type { UUID } from 'crypto'
import { getLogDisplayTitle, getErrorLogByIndex, loadErrorLogs } from '../../utils/log.js'
import {
  getLastSessionLog,
  loadMessageLogs,
} from '../../utils/sessionStorage.js'
import { loadMessagesFromJsonlPath } from '../../utils/conversationRecovery.js'
import { renderMessagesToPlainText } from '../../utils/exportRenderer.js'
import {
  DEFAULT_TASKS_MODE_TASK_LIST_ID,
  TASK_STATUSES,
  createTask,
  getTask,
  getTasksDir,
  listTasks,
  updateTask,
} from '../../utils/tasks.js'

async function resolveLogSource(
  source: string | number,
): Promise<{
  messages: unknown[]
  sessionId?: string
}> {
  if (typeof source === 'number') {
    const logs = await loadMessageLogs()
    const log = logs[source]
    if (!log) {
      throw new Error(`Log ${source} not found`)
    }
    return {
      messages: log.messages,
      sessionId: log.sessionId,
    }
  }

  const sessionLog = await getLastSessionLog(source as UUID)
  if (!sessionLog) {
    throw new Error(`Session ${source} not found`)
  }
  return {
    messages: sessionLog.messages,
    sessionId: sessionLog.sessionId,
  }
}

function printLogList(logs: Array<{ sessionId?: string; date: string; title: string }>): void {
  for (const [index, log] of logs.entries()) {
    const session = log.sessionId ? ` ${log.sessionId}` : ''
    console.log(`${index}\t${log.date}\t${log.title}${session}`)
  }
}

function getTaskListId(list?: string): string {
  return list?.trim() || DEFAULT_TASKS_MODE_TASK_LIST_ID
}

export async function logHandler(logId?: string | number): Promise<void> {
  if (logId === undefined) {
    const logs = await loadMessageLogs()
    printLogList(
      logs.map(log => ({
        sessionId: log.sessionId,
        date: log.date,
        title: getLogDisplayTitle(log),
      })),
    )
    return
  }

  const { messages } = await resolveLogSource(logId)
  const rendered = await renderMessagesToPlainText(messages as never[])
  process.stdout.write(rendered)
}

export async function errorHandler(index?: number): Promise<void> {
  if (index === undefined) {
    const logs = await loadErrorLogs()
    printLogList(
      logs.map(log => ({
        sessionId: log.sessionId,
        date: log.date,
        title: getLogDisplayTitle(log, 'Error log'),
      })),
    )
    return
  }

  const log = await getErrorLogByIndex(index)
  if (!log) {
    throw new Error(`Error log ${index} not found`)
  }
  const rendered = await renderMessagesToPlainText(log.messages as never[])
  process.stdout.write(rendered)
}

export async function exportHandler(
  source: string,
  outputFile: string,
): Promise<void> {
  let messages: unknown[]
  const resolvedSource = resolve(source)
  const extension = extname(resolvedSource).toLowerCase()

  if (extension === '.jsonl') {
    messages = (await loadMessagesFromJsonlPath(resolvedSource)).messages
  } else if (extension === '.json') {
    messages = JSON.parse(await readFile(resolvedSource, 'utf8')) as unknown[]
  } else if (/^\d+$/.test(source)) {
    messages = (await resolveLogSource(Number(source))).messages
  } else {
    messages = (await resolveLogSource(source)).messages
  }

  const rendered = await renderMessagesToPlainText(messages as never[])
  await writeFile(resolve(outputFile), rendered, 'utf8')
  console.log(resolve(outputFile))
}

export async function taskCreateHandler(
  subject: string,
  opts: { description?: string; list?: string },
): Promise<void> {
  const taskId = await createTask(getTaskListId(opts.list), {
    subject,
    description: opts.description ?? '',
    status: 'pending',
    blocks: [],
    blockedBy: [],
  })
  console.log(taskId)
}

export async function taskListHandler(opts: {
  list?: string
  pending?: boolean
  json?: boolean
}): Promise<void> {
  const tasks = await listTasks(getTaskListId(opts.list))
  const filtered = opts.pending
    ? tasks.filter(task => task.status !== 'completed')
    : tasks

  if (opts.json) {
    console.log(JSON.stringify(filtered, null, 2))
    return
  }

  for (const task of filtered) {
    console.log(`${task.id}\t[${task.status}]\t${task.subject}`)
  }
}

export async function taskGetHandler(
  id: string,
  opts: { list?: string },
): Promise<void> {
  const task = await getTask(getTaskListId(opts.list), id)
  if (!task) {
    throw new Error(`Task ${id} not found`)
  }
  console.log(JSON.stringify(task, null, 2))
}

export async function taskUpdateHandler(
  id: string,
  opts: {
    list?: string
    status?: string
    subject?: string
    description?: string
    owner?: string
    clearOwner?: boolean
  },
): Promise<void> {
  if (opts.status && !TASK_STATUSES.includes(opts.status as (typeof TASK_STATUSES)[number])) {
    throw new Error(`Invalid status: ${opts.status}`)
  }

  const updated = await updateTask(getTaskListId(opts.list), id, {
    ...(opts.status ? { status: opts.status as (typeof TASK_STATUSES)[number] } : {}),
    ...(opts.subject !== undefined ? { subject: opts.subject } : {}),
    ...(opts.description !== undefined ? { description: opts.description } : {}),
    ...(opts.clearOwner ? { owner: undefined } : {}),
    ...(opts.owner ? { owner: opts.owner } : {}),
  })

  if (!updated) {
    throw new Error(`Task ${id} not found`)
  }

  console.log(JSON.stringify(updated, null, 2))
}

export async function taskDirHandler(opts: { list?: string }): Promise<void> {
  console.log(getTasksDir(getTaskListId(opts.list)))
}

export async function completionHandler(
  shell: string,
  opts: { output?: string },
  program: {
    name?: () => string
    commands?: Array<{ name: () => string }>
  },
): Promise<void> {
  const commandName = program.name?.() ?? 'claude'
  const commands =
    program.commands?.map(command => command.name()).filter(Boolean) ?? []
  const words = commands.join(' ')

  let script: string
  switch (shell) {
    case 'bash':
      script = `_${commandName}_completions() {\n  COMPREPLY=( $(compgen -W "${words}" -- "\${COMP_WORDS[1]}") )\n}\ncomplete -F _${commandName}_completions ${commandName}\n`
      break
    case 'zsh':
      script = `#compdef ${commandName}\n_arguments "1: :(${words})"\n`
      break
    case 'fish':
      script = commands
        .map(command => `complete -c ${commandName} -f -a "${command}"`)
        .join('\n')
      break
    default:
      throw new Error(`Unsupported shell: ${shell}`)
  }

  if (opts.output) {
    await writeFile(resolve(opts.output), script, 'utf8')
    return
  }

  process.stdout.write(script)
}
