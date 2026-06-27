# Go Claude API

Use the Go SDK in backend services that value explicit typing and lightweight concurrency.

Guidance:
- Build a small wrapper around message creation so model IDs, timeouts, and retries stay centralized.
- Use contexts for cancellation.
- Keep request construction deterministic so prompt caching works reliably.

Common pattern:
- initialize client
- build the `messages` payload
- call the messages API
- map the response into your application's typed domain model
