const AUTH_PARAM_KEYS = new Set(['authToken', 'token'])
const PROTOCOL_PARAM_KEYS = new Set(['protocol', 'transport', 'scheme'])

export type ParsedConnectUrl = {
  serverUrl: string
  authToken?: string
}

export function parseConnectUrl(ccUrl: string): ParsedConnectUrl {
  if (ccUrl.startsWith('cc://')) {
    return parseTcpConnectUrl(ccUrl)
  }
  if (ccUrl.startsWith('cc+unix://')) {
    return parseUnixConnectUrl(ccUrl)
  }
  throw new Error(`Unsupported Claude Code connect URL: ${ccUrl}`)
}

function parseTcpConnectUrl(ccUrl: string): ParsedConnectUrl {
  const parsed = new URL(ccUrl)
  const authToken =
    parsed.searchParams.get('authToken') ??
    parsed.searchParams.get('token') ??
    (decodeURIComponent(parsed.username || parsed.password || '') ||
      undefined)

  const protocolParam =
    parsed.searchParams.get('protocol') ??
    parsed.searchParams.get('transport') ??
    parsed.searchParams.get('scheme')
  const protocol = protocolParam === 'https' ? 'https:' : 'http:'

  const serverUrl = new URL(
    `${protocol}//${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`,
  )
  for (const [key, value] of parsed.searchParams.entries()) {
    if (AUTH_PARAM_KEYS.has(key) || PROTOCOL_PARAM_KEYS.has(key)) {
      continue
    }
    serverUrl.searchParams.append(key, value)
  }

  return {
    serverUrl: serverUrl.toString().replace(/\/$/, ''),
    authToken,
  }
}

function parseUnixConnectUrl(ccUrl: string): ParsedConnectUrl {
  const parsed = new URL(ccUrl)
  const authToken =
    parsed.searchParams.get('authToken') ??
    parsed.searchParams.get('token') ??
    (decodeURIComponent(parsed.username || parsed.password || '') ||
      undefined)
  const socketPath = decodeURIComponent(
    `${parsed.hostname}${parsed.pathname}` || parsed.pathname,
  ).replace(/\/$/, '')

  if (!socketPath) {
    throw new Error(`Invalid Claude Code unix connect URL: ${ccUrl}`)
  }

  return {
    serverUrl: `http+unix://${encodeURIComponent(socketPath)}`,
    authToken,
  }
}
