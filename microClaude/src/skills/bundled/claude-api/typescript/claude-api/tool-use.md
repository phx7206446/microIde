# TypeScript Tool Use

Tool use is the right fit when a TypeScript app needs the model to invoke functions or external services.

Guidance:
- Model tool inputs with explicit JSON schema objects.
- Keep tool contracts versioned if multiple services consume them.
- Execute tools in trusted application code, then pass the result back in the next request.
- Distinguish between read-only and mutating tools in both naming and authorization.
