import { getOriginalCwd } from '../../bootstrap/state.js'
import { getAutoMemPath, isAutoMemoryEnabled } from '../../memdir/paths.js'
import { buildConsolidationPrompt } from '../../services/autoDream/consolidationPrompt.js'
import { recordConsolidation } from '../../services/autoDream/consolidationLock.js'
import { getProjectDir } from '../../utils/sessionStorage.js'
import { registerBundledSkill } from '../bundledSkills.js'

export function registerDreamSkill(): void {
  registerBundledSkill({
    name: 'dream',
    description:
      'Consolidate recent daily-log memory into durable topic files and refresh MEMORY.md.',
    whenToUse:
      'Use when the user asks to consolidate memory, run the nightly dream pass manually, or refresh long-term memory from recent logs.',
    userInvocable: true,
    isEnabled: () => isAutoMemoryEnabled(),
    async getPromptForCommand(args) {
      await recordConsolidation()

      const extra = args.trim().length > 0 ? `User guidance: ${args.trim()}` : ''
      return [
        {
          type: 'text',
          text: buildConsolidationPrompt(
            getAutoMemPath(),
            getProjectDir(getOriginalCwd()),
            extra,
          ),
        },
      ]
    },
  })
}
