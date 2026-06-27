# Error Codes

Common error families:
- `400` invalid request: malformed parameters, invalid tool schema, or unsupported content shape
- `401` authentication: bad or missing API key
- `403` permission: key lacks access to the requested feature or workspace
- `404` not found: missing file, batch, or resource identifier
- `429` rate limit: slow down, back off, and retry with jitter
- `5xx` server error: retry with capped exponential backoff

Handling guidance:
- Log the request shape, but never log raw secrets.
- Surface response IDs and status codes in operator logs.
- Retry only when the failure is transient.
- For streaming, handle partial output and stream interruption cleanly.
