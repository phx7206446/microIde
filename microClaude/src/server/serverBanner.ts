import type { ServerConfig } from './types.js'

function displayHost(host: string): string {
  if (host === '0.0.0.0') {
    return '127.0.0.1'
  }
  if (host === '::') {
    return '::1'
  }
  return host
}

function formatHostForUrl(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

function buildConnectUrl(
  config: ServerConfig,
  authToken: string,
  actualPort: number,
): string {
  if (config.unix) {
    return `cc+unix://${encodeURIComponent(config.unix)}?authToken=${encodeURIComponent(authToken)}`
  }

  const host = formatHostForUrl(displayHost(config.host))
  return `cc://${host}:${actualPort}?authToken=${encodeURIComponent(authToken)}`
}

export function printBanner(
  config: ServerConfig,
  authToken: string,
  actualPort: number,
): void {
  const listenTarget = config.unix
    ? `unix:${config.unix}`
    : `http://${displayHost(config.host)}:${actualPort}`
  const connectUrl = buildConnectUrl(config, authToken, actualPort)

  process.stdout.write(`Claude Code server listening on ${listenTarget}\n`)
  process.stdout.write(`Auth token: ${authToken}\n`)
  process.stdout.write(`Connect URL: ${connectUrl}\n`)
  process.stdout.write(`Open with: claude open '${connectUrl}'\n`)
}
