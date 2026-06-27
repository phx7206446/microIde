# cURL Examples

Use raw HTTP examples when the user wants to understand the wire format or is not using an official SDK.

Minimal request shape:

```bash
curl https://api.anthropic.com/v1/messages \
  -H "content-type: application/json" \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "{{SONNET_ID}}",
    "max_tokens": 1024,
    "messages": [
      { "role": "user", "content": "Summarize this document." }
    ]
  }'
```

Guidance:
- Keep headers explicit.
- Never hardcode secrets in scripts.
- Add retries only for transient failures.
