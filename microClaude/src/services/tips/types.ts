import type { ThemeName } from '../../utils/theme.js'
import type { FileStateCache } from '../../utils/fileStateCache.js'

export type TipContext = {
  theme: ThemeName
  bashTools?: Set<string>
  readFileState?: FileStateCache
}

export type Tip = {
  id: string
  content: (context: TipContext) => string | Promise<string>
  cooldownSessions: number
  isRelevant?: (context?: TipContext) => boolean | Promise<boolean>
}
