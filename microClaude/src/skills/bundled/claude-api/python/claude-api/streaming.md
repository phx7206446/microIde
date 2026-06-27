# Python Streaming

Use streaming when the UI needs token-by-token progress or when tool calls should appear incrementally.

Pattern:

```python
from anthropic import Anthropic

client = Anthropic()

with client.messages.stream(
    model="{{SONNET_ID}}",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Explain the build failure."}],
) as stream:
    for text in stream.text_stream:
        print(text, end="", flush=True)
```

Operational guidance:
- Handle stream cancellation and partial text.
- Accumulate the final message if you need durable history.
- Do not assume every event is plain text; tool-use and metadata events may appear.
