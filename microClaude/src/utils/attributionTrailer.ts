import type { AttributionData, AttributionState } from './commitAttribution.js'

export function buildPRTrailers(
  attributionData: AttributionData,
  attributionState?: AttributionState | null,
): string[] {
  const trailers = [
    `Claude-Code-Attribution: ${Math.round(attributionData.summary.claudePercent)}%`,
  ]

  if (attributionData.summary.surfaces.length > 0) {
    trailers.push(
      `Claude-Code-Surfaces: ${attributionData.summary.surfaces.join(', ')}`,
    )
  }

  const fileCount = Object.keys(attributionData.files).length
  if (fileCount > 0) {
    trailers.push(`Claude-Code-Files: ${fileCount}`)
  }

  if (attributionState?.surface) {
    trailers.push(`Claude-Code-Primary-Surface: ${attributionState.surface}`)
  }

  return trailers
}
