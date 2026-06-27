# TypeScript Files API

Use the Files API when you will reuse a large uploaded artifact across requests.

Implementation guidance:
- Upload once and persist the resulting file ID.
- Pass the file reference instead of re-uploading the payload every turn.
- Enforce cleanup and retention policies in application code.
