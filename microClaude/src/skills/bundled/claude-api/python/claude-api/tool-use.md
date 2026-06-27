# Python Tool Use

Use tool calls when the model must interact with code, files, search, or other systems.

Pattern:
- Define tools with stable names and JSON input schemas.
- Pass them in the API request.
- Execute the selected tool outside the model.
- Feed the tool result back as the next turn.

Implementation tips:
- Reject invalid arguments before execution.
- Keep tool outputs short and structured.
- Include identifiers, status, and essential payload fields.
