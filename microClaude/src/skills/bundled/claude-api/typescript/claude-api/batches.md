# TypeScript Message Batches

Use message batches for asynchronous large-scale work:
- bulk transforms
- offline evaluations
- scheduled enrichment jobs

Guidance:
- Store an application-level job record for each batch submission.
- Poll or fetch results out of band.
- Keep interactive user requests on the low-latency messages path instead.
