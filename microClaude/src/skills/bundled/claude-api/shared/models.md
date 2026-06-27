# Models

Preferred current model IDs:

| Tier | Stable ID | Notes |
| --- | --- | --- |
| Opus | `{{OPUS_ID}}` | Highest reasoning quality, best for difficult planning and review tasks |
| Sonnet | `{{SONNET_ID}}` | Default general-purpose choice for product features and agents |
| Haiku | `{{HAIKU_ID}}` | Lowest latency and cost for simple transforms and classification |

Selection guidance:
- Start with Sonnet for most product work.
- Use Opus for deep reasoning, critical reviews, or complex refactors.
- Use Haiku for lightweight tasks, retries, and cheap background processing.

Model ID rules:
- Prefer the stable IDs above in examples.
- Do not append a date suffix unless the API surface specifically requires it.
- If a codebase still references `{{PREV_SONNET_ID}}`, treat that as an older Sonnet generation and verify whether migration is intended.
