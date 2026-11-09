# Remote ingestion on ephemeral runners

Remote mode uses the Cloudflare gateway's provisioned ingestion authority for the
journal, lease and atomic active publication. No local state directory, initialized
marker, Git state commit, cache restore or persistent runner is needed. The existing
`state = ".state"` mode remains local and keeps its existing behavior. Configure
exactly one of `state` or `[remote_state]`.

The exact server contract is the [ingestion protocol](../gate/docs/ingestion-state-protocol.md).
The client and gate are versioned together here. Deploy and provision the gate
using the [deployment guide](deployment.md).

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
```

`index --apply` always acquires the lease before deciding whether to initialize or
incrementally converge. It resumes initialized interrupted runs and never resets
existing state. `update --apply` refuses an uninitialized authority. Do not choose
between commands using a pre-lock status check. Plan/status and commands without
`--apply` make read-only authority requests, report their request count, acquire no
lease and make no provider requests. Local previews remain offline. Publication
chunks pin one generation and verify total bytes and SHA-256 before use; preview
retries a changed generation at most twice.

## Source policy

Every source must be a full-history Git checkout with HEAD committed. If configured,
its branch must match exactly; a detached HEAD is rejected. After acquiring the
lease, the client reads the current authority and requires each previous publication
commit to be an ancestor of the current checkout. It never pulls source or invokes
source hooks. A stale, divergent or shallow checkout fails before provider writes.

The entire staged mode/blob/path map must equal HEAD's tree. Selected working files
must exist and contain the literal bytes of the HEAD blob. A selected HEAD regular
file replaced by a working symlink (including an ancestor symlink), or hidden behind
a newly introduced nested `.git` boundary, fails instead of becoming an apparent
deletion. Committed symlinks/gitlinks and paths excluded by static selection policy
remain excluded; local-mode working substitutions keep their existing skip policy. Git external diff,
textconv, clean/process filters, hooks and fsmonitor are not invoked by this check.
Unselected working bytes are outside the publication. Smudged LFS content, EOL
conversion and other transformed selected bytes are rejected; supporting these
needs an explicit future provenance policy. Committed LFS pointer files remain
excluded by the existing selector. The local backend still supports dirty working
files and reports null committed provenance for their changed bytes.

Hash-based file selection remains authoritative. The source is rescanned before
publication. Unchanged active entries reuse server-certified ownership and file
IDs; content changes, renames and deletions converge only through a new publication.

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
transport failures with the same UUID and body. Checkpoint/publication CAS failures
are fatal. Cleanup failures are fatal even after publication; the CLI reports the
committed publication ID separately and requires another attempt.

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

Operation reads use lookup batches of at most 50 IDs (staging needs one at a time),
cleanup pages of at most 100 records/512 KiB, and a strictly progressing keyset
cursor. No full history dictionary or growing history cache is reconstructed.
Checkpoints send explicit deltas, not complete journal snapshots. Limits are
8 KiB/operation, 100,000 operations including tombstones, 20 collections,
10,000 active files, 8 MiB manifest, 9 MiB publication snapshot, 900 KiB/chunk,
and 17 MiB publish wrapper. Prospective manifest admission reserves the maximum
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
