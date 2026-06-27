import type { LocalJSXCommandContext } from '../../commands.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { runExtraUsage } from './extra-usage-core.js'

export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: LocalJSXCommandContext,
): Promise<null> {
  const result = await runExtraUsage()

  if (result.type === 'message') {
    onDone(result.value)
    return null
  }

  onDone(
    result.opened
      ? `Opened browser: ${result.url}`
      : `Open this URL to continue: ${result.url}`,
  )
  return null
}
