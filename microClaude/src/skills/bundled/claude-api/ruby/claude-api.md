# Ruby Claude API

Use the Ruby SDK in Rails apps, scripts, and internal automation.

Guidance:
- Put client construction behind a reusable service object.
- Keep prompt templates versioned if several jobs share them.
- Prefer background jobs for large analysis tasks.
- Record request IDs and structured errors for supportability.
