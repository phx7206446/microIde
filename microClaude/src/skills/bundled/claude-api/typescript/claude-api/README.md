# TypeScript Claude API

Use the TypeScript SDK for Node.js services, CLIs, web backends, and agents built in the JavaScript ecosystem.

Minimal example:

```ts
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const message = await client.messages.create({
  model: "{{SONNET_ID}}",
  max_tokens: 1024,
  system: "You are a careful assistant.",
  messages: [{ role: "user", content: "Summarize this document." }],
});

console.log(message.content);
```

Compaction guidance:
- Summarize older turns before they become large.
- Keep tool outputs out of the prompt unless they are still relevant.
- Rebuild the request from durable application state rather than blindly replaying everything.
