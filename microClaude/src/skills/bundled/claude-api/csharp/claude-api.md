# C# Claude API

Use the C# SDK in .NET services, desktop apps, and internal tools.

Guidance:
- Reuse a configured client rather than rebuilding it per request.
- Pass cancellation tokens through the request path.
- Keep system prompts and tool schemas centralized for consistency.
- Store any durable conversation summary outside the raw transcript.
