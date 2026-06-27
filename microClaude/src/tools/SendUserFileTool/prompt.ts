export const SEND_USER_FILE_TOOL_NAME = 'SendUserFile'

export const DESCRIPTION =
  'Deliver one or more files to the user-visible channel.'

export const SEND_USER_FILE_TOOL_PROMPT = `Deliver one or more files to the user-visible channel.

Use this when the user should receive actual files rather than pasted inline content.

- Provide file paths in \`files\`
- Add \`message\` only when the user needs short context alongside the files
- Prefer this over pasting large generated files into plain text`
