import { errorMessage } from '../utils/errors.js'

export type GatewayLogger = {
  info(message: string): void
  warn(message: string): void
  error(message: string, error?: unknown): void
}

function write(level: 'INFO' | 'WARN' | 'ERROR', message: string): void {
  process.stderr.write(
    `[claude-gateway ${level} ${new Date().toISOString()}] ${message}\n`,
  )
}

export function createGatewayLogger(): GatewayLogger {
  return {
    info(message) {
      write('INFO', message)
    },
    warn(message) {
      write('WARN', message)
    },
    error(message, error) {
      write(
        'ERROR',
        error === undefined ? message : `${message}: ${errorMessage(error)}`,
      )
    },
  }
}
