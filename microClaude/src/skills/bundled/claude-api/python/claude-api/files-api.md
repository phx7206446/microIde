# Python Files API

Use the Files API when the same large file will be referenced across multiple requests.

Good fits:
- Reusing a document set in several conversations
- Uploading artifacts for repeated analysis

Avoid it when:
- The content is small
- The content is only needed once

Operational guidance:
- Track file IDs durably.
- Handle eventual cleanup and retention requirements.
- Validate file size and type before upload.
