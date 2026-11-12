# Remote ingestion on ephemeral runners

Remote mode uses the Cloudflare gateway's provisioned ingestion authority for the
journal, lease and atomic active publication. No local state directory, initialized
marker, Git state commit, cache restore or persistent runner is needed. The existing
`state = ".state"` mode remains local and keeps its existing behavior. Configure
exactly one of `state` or `[remote_state]`.

The exact server contract is the [ingestion protocol](../gate/docs/ingestion-state-protocol.md).
The client and gate are versioned together here. Deploy and provision the gate
using the [deployment guide](deployment.md). The gate must advertise
`async-submit-v1`; a remote sync refuses older gates before provider writes.

## Fresh authority setup

An administrator provisions an immutable workspace, OpenAI project, collection
repository/branch/store ownership and query credential environment name. Only
verified Access service identities with a separate publisher grant may ingest.
Use fresh, empty vector stores and an unmanaged workspace. Local journals and
manual gate imports cannot be adopted or silently rebound. There is no legacy
migration or history-compaction API in this increment.

Use [the example TOML](../examples/github-actions/wiki-rag.remote.toml). The origin
is read from its named environment variable and must be an exact HTTPS origin
without credentials, path, query or fragment. Access service credentials and the
project ingestion key also come only from named environment variables. Requests
never follow redirects or inherit proxy settings. No credentials or document
bodies are stored in the journal.

```sh
uv run wiki-rag --config wiki-rag.remote.toml plan
uv run wiki-rag --config wiki-rag.remote.toml index --apply
uv run wiki-rag --config wiki-rag.remote.toml update --apply
uv run wiki-rag --config wiki-rag.remote.toml status --summary
```

`index --apply` always acquires the lease before deciding whether to initialize or
incrementally converge. It resumes initialized interrupted runs and never resets
existing state. `update --apply` refuses an uninitialized authority. Do not choose
between commands using a pre-lock status check. Plan/status and commands without
`--apply` make read-only authority requests, report their request count, acquire no
lease and make no provider requests. Local previews remain offline. Publication
chunks pin one generation and verify total bytes and SHA-256 before use; preview
retries a changed generation at most twice.

## Asynchronous submission

The CLI uploads at most eight files concurrently and submits attachments in batches
of at most 500 per store, preserving each file's attributes and chunking. This
operational size keeps individual provider requests below the API's larger maximum;
it does not limit the total corpus. Only the
active upload window receives durable upload intents. Journal mutations stay on the
coordinator thread, and all dispatched workers drain before clients close. On an
ordinary upload failure, successful sibling receipts are persisted; authority loss
prevents further journal writes and leaves dispatched outcomes for reconciliation.

An unknown attachment result is reconciled by immutable File ID and the original
operation attributes. For an existing attachment with exactly empty attributes,
the OpenAI adapter can finish the pending metadata write. It rehashes the current
source against the durable acknowledged-upload receipt, verifies the provider File
ID, unique upload filename, byte count and purpose, and checks attachment identity,
status and chunking. Content identity relies on that acknowledged upload and its
immutable File ID; this recovery does not claim a fresh download/hash of provider
bytes. It rechecks attributes before updating and requires matching readback before
checkpointing. Missing attachments, conflicting nonempty metadata or failed proof
remain errors. The existing file and attachment are retained.

Attachment batches retry an explicit HTTP 429 rejection at most twice, using
`Retry-After` capped at 60 seconds (60 seconds if absent or malformed), and check
the writer lease before every attempt. Unknown create outcomes such as HTTP 500
or a transport failure keep their durable intent for reconciliation.

Provider diagnostics identify the operation stage, masked HTTP route, batch size,
attempt, elapsed milliseconds, HTTP status and OpenAI request ID. Batch submission
and metadata recovery log start/completion separately; reconciliation reports
pending/found/confirmed counts. Failures retain recognized error codes and parameter
paths plus a bounded provider explanation. Known credentials and request attribute
values, resource IDs, URLs, email addresses and quoted data are redacted before
truncation. Request bodies, document bytes, headers and complete response bodies
are never serialized. Provider prose redaction is best-effort; keep consumer logs
as private operational records rather than publishing them as generic tool artifacts.

Background attachment failures expose bounded job diagnostics through publisher
status and the GHA observer: operation ID, attachment status, metadata state/field,
recognized provider error code and vector-store usage bytes when available.
The [ingestion protocol](../gate/docs/ingestion-state-protocol.md) owns the exact
shape and terminal-recovery boundary. A later publisher logs selected source bytes
and the existing attempt count for that operation; source and vector-store sizes
measure different things. No provider prose is included in these job diagnostics.

After attachment submission and a matching rescan, `submit` durably captures the
exact manifest. The CLI returns `mode: submitted` and `job_id`, without waiting for
OpenAI indexing. A Durable Object alarm verifies readiness and atomically publishes
all collections. `status --summary` exposes pending/complete/failed/superseded/revoked
job progress without manifest contents. A failed job leaves the prior publication
active; a new writer lease supersedes an older pending job. No-op sync after completion
returns `mode: applied` and the existing publication ID, with no new job.

Job metadata includes `created_at` and nullable `finished_at` (Unix milliseconds),
plus nullable `duration_ms`. Pending jobs and legacy jobs without a recorded end
time have no duration. For an already-published workspace, the read-only MCP
`status` tool exposes this metadata as `indexing`; `documents` still counts the
active publication. The CLI remains asynchronous; the reusable GitHub workflow
adds a separate five-minute status wait. That workflow fails on an indexing error
or timeout, while a CLI submission alone does not establish successful publication.

The gate's read credential only checks readiness; it never uploads, attaches or
performs cleanup. The next publisher sync cleans obsolete owned resources before
submission, retaining all operation IDs selected for the current snapshot. No journal
mutations follow submission, because that revision fences background publication.

## Source policy

Every source must be a full-history Git checkout with HEAD committed. If configured,
its branch must match exactly; a detached HEAD is rejected. After acquiring the
lease, the client reads the current authority and requires each previous publication
commit to be an ancestor of the current checkout. It never pulls source or invokes
source hooks. A stale, divergent or shallow checkout fails before provider writes.

The entire staged mode/blob/path map must equal HEAD's tree. Selected ordinary working files
must exist and contain the literal bytes of the HEAD blob. A selected HEAD regular
file replaced by a working symlink (including an ancestor symlink), or hidden behind
a newly introduced nested `.git` boundary, fails instead of becoming an apparent
deletion. Committed symlinks/gitlinks and paths excluded by static selection policy
remain excluded; local-mode working substitutions keep their existing skip policy. Git external diff,
textconv, clean/process filters, hooks and fsmonitor are not invoked by this check.
Unselected working bytes are outside the publication. EOL conversion and unverified
transformed selected bytes are rejected. Explicit `lfs = true` sources verify native
bytes against committed pointer hashes/sizes; explicit generators execute exported
HEAD inputs in a temporary tree. These sources require `file-origin-v1` before
provider mutations, including cleanup. See [derived sources](derived-sources.md).
Without that opt-in LFS pointers remain excluded. The local backend still supports dirty working
files and reports null committed provenance for their changed bytes.

Hash-based file selection remains authoritative. The source is rescanned before
submission. Unchanged active entries reuse server-certified ownership and file
IDs; content changes, renames and deletions converge only through a new publication.
Derived preparation also captures a separate input/recipe/output identity for the
rescan, so unchanged upload bytes cannot hide a concurrent preparation change.

## Failure and concurrency behavior

A run owns one 120-second lease. An independent heartbeat renews every 30 seconds;
a conservative monotonic deadline also catches suspended or delayed clients.
Renewal failure permanently poisons the attempt. Every provider mutation has an
acknowledged intent first, then an outcome checkpoint; the HTTP adapter checks
lease health immediately before every mutating attempt, including DELETE retries.
There is no in-place reacquisition after lease or revision loss.

Initial contention waits with jitter and Retry-After for at most
`lease_wait_seconds` (default 300, configurable 0–1800). Timeout and stale-source
errors require an explicit fresh rerun/recheckout. Commands retry ambiguous
transport failures with the same UUID and body. Checkpoint/submission CAS failures
are fatal. Cleanup failures stop submission; the previous publication remains active.

OpenAI is outside the Durable Object transaction. Already-dispatched effects may
finish after lease expiry. Unique upload filenames/content hashes and attachment
operation IDs allow conservative recovery. Missing or ambiguous evidence retains
the pending ownership intent and fails explicitly, even when its source version
is obsolete. An obsolete `upload_ready` record has no dispatched effect but no
protocol-v1 tombstone transition; it remains owned and is reported for operator
review. Rerunning alone does not clear that record. Recovery requires a deliberate
forward source commit reselecting its exact path/version to finish normal ingestion,
or a future separately reviewed administrative maintenance mechanism; this client
does not upload obsolete content merely to clear a record. Deleted attempts remain tombstones. Reusing a logical version first
finishes retirement, then atomically preserves its deleted receipt under a retired
ID before starting with a fresh filename/file ID. Old retirement IDs never reactivate.

The lease fences journal/publication changes, not arbitrary direct OpenAI calls.
Publisher credentials also hold project-scoped ingestion permissions; trusted
protected-branch code and restricted credentials are required. This is not an
end-to-end exactly-once provider guarantee or remote cancellation mechanism.

Operation reads use lookup batches of at most 50 selected IDs,
cleanup pages of at most 100 records/512 KiB, and a strictly progressing keyset
cursor. No full history dictionary or growing history cache is reconstructed.
Checkpoints send explicit deltas of at most 100 operations and 512 KiB per request,
not complete journal snapshots. Every operation phase remains a separate transition. Limits are
8 KiB/operation, 100,000 operations including tombstones, 20 collections,
10,000 active files, 8 MiB manifest, 9 MiB publication snapshot, 900 KiB/chunk,
and 17 MiB publication/submission wrapper. Prospective manifest admission reserves the maximum
provider file-ID length before uploads. The server rejects operation quota before
a new intent can dispatch. Maintenance beyond 100,000 records needs an explicit
future administrative workflow; history is never silently truncated.

## GitHub Actions integration artifact

For automatic source checkout and a shared `workflow_call` interface, use the
[reusable workflow guide](github-actions.md). It documents token inputs, optional
GitHub credentials, tool revision pinning and shared configuration. The existing
manual-checkout entry points below remain available.

[The local composite action](../.github/actions/ingest/action.yml) is usable from a
reviewed copy of this tool source. [The consumer workflow template](../examples/github-actions/ingest.yml)
is deliberately outside `.github/workflows`; it is not enabled. No repository,
credential, workflow or deployment is created by these files.

Before enabling, put the reviewed tool source at `tools/wiki-rag` in a central
orchestrator repository (or replace this with an actually published reviewed
release). Copy the TOML example to the caller workspace root and adapt the explicit
repository identities, branches, roots and provisioned stores. Check out every
configured source repository; publication covers the whole workspace. The example
has two matching full-history checkouts, with no submodules. It uses Python 3.14,
uv with the locked dependency set, contents-read permissions, a protected publisher
environment, a 30-minute job timeout and `cancel-in-progress: false`.

Allow trusted default/protected-branch pushes and manual dispatch only. Replace
example action tags with organization-approved immutable pins when installing the
workflow. Restrict the environment and service credentials to those trusted jobs.
For private repositories, use a narrowly scoped contents-read credential that can
read all configured repositories; a caller's default token normally covers only
the caller repository. Do not enable this on pull requests or untrusted branches.

GitHub concurrency is repository-local; the remote lease is authoritative across
repositories. A central caller per workspace is recommended. This template does
not arrange cross-repository trigger delivery, retries after cancelled pending
jobs, or eventual synchronization. A missing event, timeout or stale checkout
requires a fresh explicit run or a separately designed orchestrator.

## Qualification

Run the local suite with `uv run pytest`. For real workerd acceptance, install the gate dependencies and point to the in-repository gate:

```sh
npm ci --prefix gate
WIKI_RAG_GATE_SOURCE="$PWD/gate" uv run pytest tests/test_workerd.py
```

The test-only stdio transport bridge bundles the real Worker, signs synthetic
Access assertions, uses local workerd/SQLite, and keeps each source invocation in
a new full clone. It tests crash/lost-response recovery, no-op identity, updates,
rename/deletion and retired-attempt replacement. The delayed upload test keeps the
old effect absent through successor publication, verifies explicit unresolved
ownership and stale checkpoint/publish rejection, then makes the effect visible
and proves a fresh runner cleans up only its obsolete ID. A delayed old-ID deletion
also executes after logical-version replacement and leaves the new publication and
provider file intact.
It never adds a deployed auth bypass or calls a cloud service.
