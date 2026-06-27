# TypeScript Agent SDK

Use the TypeScript Agent SDK when the application needs a long-lived tool-using agent rather than a single completion call.

Good fits:
- coding assistants
- operator consoles
- automation flows that coordinate tools over several steps

Guidance:
- Keep the allowed tool list intentionally small.
- Push domain rules into code where possible.
- Persist state transitions if the agent can resume or hand off work.
