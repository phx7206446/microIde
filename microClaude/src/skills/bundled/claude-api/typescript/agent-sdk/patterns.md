# TypeScript Agent SDK Patterns

Recommended patterns:
- Model side effects explicitly in tool wrappers.
- Separate UI streaming from durable state updates.
- Use structured task objects instead of free-form strings for internal orchestration.
- Normalize errors so retries and telemetry can reason about them consistently.
