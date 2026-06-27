import { cliError, cliOk } from '../exit.js'
import { errorMessage } from '../../utils/errors.js'
import { runProjectPurge } from '../../utils/projectPurge.js'

export async function projectPurgeHandler(
  targetPath: string | undefined,
  options: {
    all?: boolean
    dryRun?: boolean
    yes?: boolean
    interactive?: boolean
  },
): Promise<void> {
  if (targetPath && options.all) {
    cliError('Cannot specify a project path with --all')
  }

  try {
    const result = await runProjectPurge(targetPath, options)
    if (result === 'not_found') {
      cliError('No matching project-scoped Claude state found')
    }
    if (result === 'cancelled') {
      cliOk('Project purge cancelled')
    }
    cliOk(options.dryRun ? 'Dry run complete' : 'Project purge complete')
  } catch (error) {
    cliError(`Project purge failed: ${errorMessage(error)}`)
  }
}
