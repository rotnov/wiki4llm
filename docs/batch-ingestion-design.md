# Batched remote ingestion

## Accepted behavior

Upload independent files concurrently, submit vector-store attachments in batches,
and check readiness for the collection rather than waiting after each file.
Preserve the existing publication until all required files are complete.
The CLI/workflow sync returns after durable submission. No CI runner polls OpenAI
or waits for indexing. A Cloudflare Durable Object alarm verifies readiness and
publishes the captured immutable snapshot. Submission is never reported as a
completed index; publisher status reports pending, failed, superseded or complete.

## Implementation boundaries

- Keep the deployed authority identity and per-file operation schema. Use its
  existing lookup limit of 50 and checkpoint limit of 100, also respecting byte
  limits. Journal mutations stay on the coordinator thread; only provider uploads
  run concurrently, with eight workers.
- Keep per-file immutable ownership, filename, content digest and operation ID,
  including the original operation's source revision on resumed files. Persist
  upload intents only for the active worker-sized dispatch window. Drain workers
  before closing clients. Persist successful outcomes after ordinary provider
  failures; on authority loss leave outcomes pending for reconciliation instead.
  Unknown uploads reconcile by existing identity and digest, never blind retry.
- Group uploaded files by store and submit at most 2000 per OpenAI file batch,
  preserving per-file attributes and chunking. Save attach intents first. A lost
  response reconciles the exact journal-owned file IDs/attributes through bounded
  vector-store listing; unknown missing attachments remain pending for retry.
- Per-file journal receipts remain the recovery authority when a batch response
  is lost. Add a fenced, idempotent `submit` authority command carrying the exact
  manifest captured and rescanned by the CLI. The response includes `job_id` and
  a journal revision. Persist the manifest, submitting publisher, authority epoch,
  base revision and readiness state in SQLite; never store credentials in jobs.
- The alarm uses the existing bound query credential for read-only provider status.
  Poll bounded pages, verify file IDs and original attributes, and record progress.
  Reject malformed responses and terminal provider failures without publication.
  Keep the old publication until every submitted file is complete. Retain every
  operation phase transition; no direct attach_pending-to-complete shortcuts.
- Before each background result or publication, recheck authority binding,
  submitting publisher grant, job identity, epoch and revision. A newly acquired
  writer lease supersedes an older pending job. Never publish a stale snapshot
  after a newer writer, disablement or grant revocation. Revocation and disablement
  permanently terminalize pending jobs, even if access is subsequently restored.
  Background work uses the accepted bounded delegation, never a fabricated JWT.
- Pre-arm the alarm before committing a durable submission; reschedule before
  network work so a crash cannot orphan the job. Serialize alarm scheduling and
  multiplex workspace jobs on the object's single alarm. Bound provider requests,
  response sizes and job lifetime; expose sanitized failures through status.
- Background completion updates operation receipts and publication atomically.
  It does not need a provider write credential. Provider cleanup remains publisher
  work on the next sync/no-op; keep current selected operation IDs while cleaning
  obsolete owned resources. Reader filtering already excludes retired versions.
- Reuse completed operations from the old serial path. Terminal failures retain
  bounded recovery. Background finalization never starts uploads or attachments.
  Local-state ingestion keeps its existing behavior; remote sync is asynchronous.
- Add aggregate progress to stderr without document bodies, paths or credentials.

## Test-first work

1. Add failing provider tests for batch request metadata, pagination and malformed
   responses; implement the fixed-origin provider methods.
2. Add failing remote integration tests proving upload overlap, one attachment
   batch for a small corpus, no per-file polling, bounded checkpoint requests,
   interruption recovery, partial failure, old serial receipts and lease loss.
   Implement the remote batch coordinator and preserve the old local engine.
3. Add the durable submission/alarm path and real-workerd tests proving crash
   recovery, exact snapshot identity, stale-writer/revocation rejection, bounded
   polling, terminal failure and atomic publication. Add CLI/GHA tests proving
   sync returns pending without any provider polling and no-op remains stable.
4. Run the full Python and real-workerd suite, formatting/build/docs/public checks,
   and independent review. Deploy the backend gate first, then publish the tool,
   resume the authorized real corpus, verify background completion/no-op/MCP,
   then restore automatic indexing. Preserve the separate reader front and OAuth.

## Provider contract

[OpenAI file batches](https://developers.openai.com/api/reference/resources/vector_stores/subresources/file_batches/methods/create)
accept up to 2000 file IDs or per-file objects and return asynchronous status.
[Files upload](https://developers.openai.com/api/reference/resources/files/methods/create)
accepts one file per request; the client supplies bounded upload concurrency.
