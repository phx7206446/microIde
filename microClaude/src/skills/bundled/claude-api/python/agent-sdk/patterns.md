# Python Agent SDK Patterns

Recommended patterns:
- Separate planning prompts from execution prompts when the task has side effects.
- Wrap external tools with clear timeout, retry, and logging behavior.
- Store the final artifact or summary outside the chat transcript.
- Prefer deterministic helper functions around the agent rather than embedding business logic in prompt text.
