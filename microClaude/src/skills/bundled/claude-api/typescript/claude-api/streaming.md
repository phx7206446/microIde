# TypeScript Streaming

Use streaming for CLIs and UIs that should render output incrementally.

Pattern:
- Open a streaming request
- Render text deltas as they arrive
- Collect the final result for storage or follow-up actions

Guidance:
- Treat stream events as typed events, not just strings.
- Abort cleanly when the user cancels the request.
- Preserve the final structured message if the application resumes later.
