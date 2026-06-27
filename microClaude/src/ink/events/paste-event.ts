import { TerminalEvent } from './terminal-event.js'

/**
 * Paste event dispatched through the terminal event tree.
 *
 * Mirrors the browser's ClipboardEvent shape closely enough for Ink host
 * components: a single pasted text payload plus normal capture/bubble flow.
 */
export class PasteEvent extends TerminalEvent {
  readonly text: string

  constructor(text: string) {
    super('paste', { bubbles: true, cancelable: true })
    this.text = text
  }
}
