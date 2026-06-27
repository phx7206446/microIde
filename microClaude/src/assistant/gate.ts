import { checkGate_CACHED_OR_BLOCKING } from '../services/analytics/growthbook.js'

export async function isKairosEnabled(): Promise<boolean> {
  return checkGate_CACHED_OR_BLOCKING('tengu_kairos')
}
