# Python Claude API

Use the Python SDK when the project is already Python-first or when the user wants server-side integrations.

Basic flow:
1. Create an `Anthropic` client with the API key in the environment.
2. Send `messages.create(...)` with a stable `model`, `max_tokens`, and a `messages` array.
3. Keep the system prompt stable when prompt caching matters.

Minimal example:

```python
from anthropic import Anthropic

client = Anthropic()

message = client.messages.create(
    model="{{SONNET_ID}}",
    max_tokens=1024,
    system="You are a careful assistant.",
    messages=[{"role": "user", "content": "Summarize this document."}],
)

print(message.content)
```

Compaction guidance:
- Persist the important state yourself.
- Summarize or compress older turns before the conversation becomes too large.
- Store tool outputs separately if they are expensive to resend.

Prompt caching:
- Put the large reusable prefix in the stable leading portion of the request.
- Reuse the same tool schemas and system text when possible.
