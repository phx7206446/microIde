# Claude API

Use this skill when the user is building with the Claude API, Anthropic SDKs, or the Agent SDK.

Your job:
- Match the advice to the user's language and stack.
- Prefer the bundled reference docs before improvising.
- Keep model names and IDs explicit. Current defaults are `{{OPUS_ID}}`, `{{SONNET_ID}}`, and `{{HAIKU_ID}}`.
- If the user needs exact up-to-date pricing, beta headers, or a newly launched feature, use WebFetch against Anthropic docs.

Focus areas:
- Basic messages API usage
- Streaming responses
- Tool use / function calling
- Prompt caching and long conversations
- Batch jobs and file uploads
- Agent SDK patterns for Python and TypeScript

## Reading Guide

The runtime injects a language-specific reading guide and the matching bundled markdown files after this section.

## When to Use WebFetch

Use WebFetch when:
- The user asks for the latest pricing, limits, or model availability
- The bundled docs do not cover the requested feature
- The user wants exact documentation links or current beta-header requirements
- A feature appears newer than the bundled reference set

## Common Pitfalls

- Do not guess model IDs. Use the explicit IDs in the bundled model docs.
- Do not recommend prompt caching until the prompt prefix is stable across requests.
- Do not treat tool use as a raw string-concatenation problem; require a stable schema and validate tool inputs.
- Do not recommend file uploads when inline content is smaller and only used once.
- Do not assume Agent SDK guidance applies to every language; it is bundled here only for Python and TypeScript.
