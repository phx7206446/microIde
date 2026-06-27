# Tool Use Concepts

Tool use is structured function calling.

Core rules:
- Define a clear JSON schema for each tool.
- Keep tool names stable and intention-revealing.
- Validate tool input before execution.
- Return compact, machine-usable tool results.
- Feed the tool result back into the next model turn instead of flattening everything into prose.

Design guidance:
- Prefer a few high-signal tools over many overlapping ones.
- Make side effects explicit.
- Separate read-only tools from mutating tools when possible.
- Include retries and timeout handling around external systems.
