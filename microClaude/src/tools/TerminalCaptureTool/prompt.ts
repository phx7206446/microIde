export const TERMINAL_CAPTURE_TOOL_NAME = 'TerminalCapture'

export const DESCRIPTION = `Capture scrollback from the built-in terminal panel.

Usage:
- Reads from the persistent Meta+J terminal panel when a tmux-backed panel session exists
- Returns recent terminal output as plain text for inspection
- Use this when you need to inspect shell output that is currently sitting in the terminal panel
- If the terminal panel has never been opened, the tool returns unavailable`
