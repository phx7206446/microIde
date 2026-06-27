import { REVIEW_ARTIFACT_TOOL_NAME } from '../../tools/ReviewArtifactTool/constants.js'
import { registerBundledSkill } from '../bundledSkills.js'

const HUNTER_PROMPT = `# Hunter

Use this skill when the user wants you to inspect review artifacts that were generated outside the normal transcript.

When multiple artifacts are plausible, call \`${REVIEW_ARTIFACT_TOOL_NAME}\` before inspecting them so the user can choose the exact artifact Claude should focus on. Prefer rich \`artifacts\` entries with short labels and descriptions. If you only have raw links, pass them through \`artifact_urls\`.

After the user chooses an artifact:
1. Fetch, open, or read the selected artifact.
2. Summarize the important findings.
3. Call out bugs, regressions, or follow-up work.
4. If the artifact is inconclusive, say what additional artifact is needed.

If the user already named the exact artifact to inspect, skip \`${REVIEW_ARTIFACT_TOOL_NAME}\` and inspect it directly.`

export function registerHunterSkill(): void {
  registerBundledSkill({
    name: 'hunter',
    description:
      'Inspect review artifacts and ask the user to choose the right artifact when needed.',
    userInvocable: true,
    async getPromptForCommand(args) {
      let prompt = HUNTER_PROMPT
      if (args) {
        prompt += `\n\n## User Request\n\n${args}`
      }
      return [{ type: 'text', text: prompt }]
    },
  })
}
