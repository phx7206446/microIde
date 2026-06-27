# PHP Claude API

Use the PHP SDK in Laravel, Symfony, or smaller server-rendered applications.

Guidance:
- Keep client setup in application bootstrap code.
- Wrap API calls in a small service layer so retries, logging, and model selection stay consistent.
- Use background jobs for slow or high-volume processing rather than tying everything to request latency.
