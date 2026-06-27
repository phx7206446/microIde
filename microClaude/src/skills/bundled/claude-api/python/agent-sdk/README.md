# Python Agent SDK

Use the Python Agent SDK when the user wants an agent that can coordinate tools and maintain a richer execution loop than a single API call.

Use it for:
- Tool-using assistants
- File and terminal workflows
- Multi-step task execution with durable orchestration

Guidance:
- Start from a narrow tool surface.
- Keep agent instructions explicit about boundaries and side effects.
- Persist important run metadata outside the agent loop if the application needs auditability.
