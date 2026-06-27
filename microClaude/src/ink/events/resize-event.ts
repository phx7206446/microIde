import { TerminalEvent } from './terminal-event.js'

/**
 * Terminal resize notification for host components that care about viewport
 * changes. This is a continuous event and does not bubble.
 */
export class ResizeEvent extends TerminalEvent {
  readonly columns: number
  readonly rows: number

  constructor(columns: number, rows: number) {
    super('resize', { bubbles: false, cancelable: false })
    this.columns = columns
    this.rows = rows
  }
}
