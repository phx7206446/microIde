export const SNIP_TOOL_NAME = 'Snip'

export const DESCRIPTION = `Remove older user turns from the active conversation context when they are no longer needed.

Usage:
- Only pass IDs that appear as [id:xxxxxx] suffixes on user messages
- Each ID removes that user turn plus the assistant/tool messages that follow it until the next real user turn
- Use this to drop stale exploration, completed detours, or finished debugging branches
- Never snip the most recent turns or anything you still need for the current task`
