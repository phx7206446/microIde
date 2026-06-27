# Prompt Caching

Prompt caching is useful when a large, stable prefix repeats across many requests.

Apply it when:
- The system prompt is large and mostly fixed
- Tool specs or long reference material repeat across requests
- Multiple users or turns reuse the same preamble

Avoid it when:
- The prompt prefix changes substantially every request
- The request is small enough that cache bookkeeping is not worth it

Operational guidance:
- Keep the reusable prefix stable and put the volatile user content after it.
- Measure cache-hit rate before and after changes.
- If the user complains about poor hit rates, inspect prompt drift first.
