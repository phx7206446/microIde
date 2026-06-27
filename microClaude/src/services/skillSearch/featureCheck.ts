import { feature } from 'bun:bundle'
import { isBareMode } from '../../utils/envUtils.js'

export function isSkillSearchEnabled(): boolean {
  if (!feature('EXPERIMENTAL_SKILL_SEARCH')) {
    return false
  }
  if (isBareMode()) {
    return false
  }
  if (process.env.CLAUDE_CODE_DISABLE_SKILL_SEARCH === 'true') {
    return false
  }
  return (
    process.env.CLAUDE_CODE_ENABLE_SKILL_SEARCH === 'true' ||
    process.env.USER_TYPE === 'ant'
  )
}
