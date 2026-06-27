# Python Message Batches

Use batches for large asynchronous workloads where end-user latency is not critical.

Good fits:
- Bulk classification
- Offline enrichment
- Large evaluation runs

Guidance:
- Treat each task as independently retryable.
- Persist your own task IDs alongside batch IDs.
- Fetch results asynchronously rather than blocking interactive flows.
