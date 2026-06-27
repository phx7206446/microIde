import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
  logEvent,
} from '../../services/analytics/index.js'
import type { RemoteSkillFetchMethod } from './remoteSkillLoader.js'

type RemoteSkillLoadTelemetry = {
  slug: string
  cacheHit: boolean
  latencyMs: number
  urlScheme: 'gs' | 'http' | 'https' | 's3'
  fileCount?: number
  totalBytes?: number
  fetchMethod?: RemoteSkillFetchMethod
  error?: string
}

export function logRemoteSkillLoaded({
  slug,
  cacheHit,
  latencyMs,
  urlScheme,
  fileCount,
  totalBytes,
  fetchMethod,
  error,
}: RemoteSkillLoadTelemetry): void {
  logEvent('tengu_remote_skill_loaded', {
    _PROTO_skill_name: slug as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
    cache_hit: cacheHit,
    latency_ms: latencyMs,
    url_scheme:
      urlScheme as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    ...(fetchMethod && {
      fetch_method:
        fetchMethod as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    }),
    ...(fileCount !== undefined && { file_count: fileCount }),
    ...(totalBytes !== undefined && { total_bytes: totalBytes }),
    ...(error && {
      error:
        error as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    }),
  })
}
