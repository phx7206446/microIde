import { getSystemThemeName, type SystemTheme } from './systemTheme.js'

export function watchSystemTheme(
  _querier: unknown,
  onThemeChange: (theme: SystemTheme) => void,
): () => void {
  onThemeChange(getSystemThemeName())
  return () => {}
}
