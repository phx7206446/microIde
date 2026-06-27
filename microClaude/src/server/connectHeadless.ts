/* eslint-disable eslint-plugin-n/no-unsupported-features/node-builtins */

import { randomUUID } from 'crypto'
import { createInterface } from 'readline/promises'
import { getSessionId } from '../bootstrap/state.js'
import type { SDKMessage, SDKResultMessage } from '../entrypoints/agentSdkTypes.js'
import { EMPTY_USAGE } from '../services/api/emptyUsage.js'
import { errorMessage } from '../utils/errors.js'
import { peekForStdinData, writeToStderr, writeToStdout } from '../utils/process.js'
import { jsonStringify } from '../utils/slowOperations.js'
import {
  type DirectConnectConfig,
  DirectConnectSessionManager,
} from './directConnectManager.js'

type HeadlessOutputFormat = 'text' | 'json' | 'stream-json'

function normalizeOutputFormat(outputFormat: string): HeadlessOutputFormat {
  switch (outputFormat) {
    case 'json':
    case 'stream-json':
      return outputFormat
    default:
      return 'text'
  }
}

function isResultMessage(message: SDKMessage): message is SDKResultMessage {
  return message.type === 'result'
}

async function readPromptFromStdin(interactive: boolean): Promise<string> {
  if (!process.stdin.isTTY) {
    process.stdin.setEncoding('utf8')
    let data = ''
    const onData = (chunk: string) => {
      data += chunk
    }
    process.stdin.on('data', onData)
    const timedOut = await peekForStdinData(process.stdin, 3000)
    process.stdin.off('data', onData)
    if (timedOut) {
      writeToStderr(
        'Warning: no stdin data received in 3s, proceeding without it.\n',
      )
    }
    return data
  }

  if (!interactive) {
    return ''
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  })
  try {
    return await rl.question('Prompt: ')
  } finally {
    rl.close()
  }
}

async function resolvePrompt(
  prompt: string,
  interactive: boolean,
): Promise<string> {
  const stdinPrompt = await readPromptFromStdin(interactive)
  return [prompt, stdinPrompt].filter(Boolean).join('\n').trim()
}

function emitStreamJsonError(message: string): void {
  writeToStdout(
    jsonStringify({
      type: 'result',
      subtype: 'error_during_execution',
      duration_ms: 0,
      duration_api_ms: 0,
      is_error: true,
      num_turns: 0,
      stop_reason: null,
      session_id: getSessionId(),
      total_cost_usd: 0,
      usage: EMPTY_USAGE,
      modelUsage: {},
      permission_denials: [],
      uuid: randomUUID(),
      errors: [message],
    }) + '\n',
  )
}

function emitResult(
  result: SDKResultMessage,
  outputFormat: HeadlessOutputFormat,
): void {
  switch (outputFormat) {
    case 'json':
      writeToStdout(jsonStringify(result) + '\n')
      break
    case 'stream-json':
      break
    default:
      switch (result.subtype) {
        case 'success':
          writeToStdout(
            result.result.endsWith('\n') ? result.result : `${result.result}\n`,
          )
          break
        case 'error_during_execution':
          writeToStdout('Execution error')
          break
        case 'error_max_turns':
          writeToStdout('Error: Reached max turns')
          break
        case 'error_max_budget_usd':
          writeToStdout('Error: Exceeded USD budget')
          break
        case 'error_max_structured_output_retries':
          writeToStdout(
            'Error: Failed to provide valid structured output after maximum retries',
          )
          break
        default:
          writeToStdout('Execution error\n')
      }
  }
}

async function runPrompt(
  config: DirectConnectConfig,
  prompt: string,
  outputFormat: HeadlessOutputFormat,
): Promise<SDKResultMessage> {
  let manager: DirectConnectSessionManager | null = null

  try {
    return await new Promise<SDKResultMessage>((resolve, reject) => {
      let settled = false
      let permissionDenied = false

      const finish = (fn: () => void) => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(connectTimeout)
        fn()
      }

      const connectTimeout = setTimeout(() => {
        finish(() => {
          reject(new Error(`Timed out connecting to ${config.wsUrl}`))
        })
      }, 15000)

      manager = new DirectConnectSessionManager(config, {
        onConnected: () => {
          if (!manager?.sendMessage(prompt)) {
            finish(() => {
              reject(new Error('Failed to send prompt to Claude Code server'))
            })
          }
        },
        onMessage: message => {
          if (outputFormat === 'stream-json') {
            writeToStdout(jsonStringify(message) + '\n')
          }

          if (isResultMessage(message)) {
            finish(() => {
              resolve(message)
            })
          }
        },
        onPermissionRequest: (request, requestId) => {
          permissionDenied = true
          manager?.respondToPermissionRequest(requestId, {
            behavior: 'deny',
            message:
              'Direct connect headless mode cannot answer permission prompts. Retry without --print or use --dangerously-skip-permissions.',
          })
          writeToStderr(
            `Permission denied for ${request.tool_name} in direct connect headless mode.\n`,
          )
        },
        onDisconnected: () => {
          finish(() => {
            reject(
              new Error(
                permissionDenied
                  ? 'Direct connect session closed after a permission request was denied'
                  : 'Disconnected from Claude Code server before the session completed',
              ),
            )
          })
        },
        onError: err => {
          finish(() => {
            reject(err)
          })
        },
      })

      manager.connect()
    })
  } finally {
    manager?.disconnect()
  }
}

export async function runConnectHeadless(
  config: DirectConnectConfig,
  prompt: string,
  outputFormat: string,
  interactive: boolean,
): Promise<void> {
  const normalizedOutputFormat = normalizeOutputFormat(outputFormat)

  try {
    const resolvedPrompt = await resolvePrompt(prompt, interactive)
    if (resolvedPrompt.length === 0) {
      throw new Error('No prompt provided for direct connect headless mode')
    }

    const result = await runPrompt(config, resolvedPrompt, normalizedOutputFormat)
    emitResult(result, normalizedOutputFormat)
    process.exitCode = result.is_error ? 1 : 0
  } catch (err) {
    const message = errorMessage(err)
    if (normalizedOutputFormat === 'stream-json') {
      emitStreamJsonError(message)
    } else {
      writeToStderr(`Error: ${message}\n`)
    }
    process.exitCode = 1
  }
}
