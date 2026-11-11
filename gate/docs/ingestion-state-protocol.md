# Durable ingestion protocol v1

The Cloudflare gateway's fixed `authority-v1` Durable Object is the authority for
remote ingestion. This protocol is separate from the five public read-only MCP
tools and from the Python CLI's legacy local `state.json` checksum. The server
implementation is `src/cloudflare/ingestion.ts`; HTTP admission is in `worker.ts`,
and asynchronous provider checks are in `background.ts`.
All examples below use synthetic identifiers. No document bodies or credentials
belong in this journal.

## Authentication and HTTP

Use the configured exact HTTPS gateway origin, without user information, a path,
query, or fragment. Clients must not follow redirects. Hosted callers use
`CF-Access-Client-Id` and `CF-Access-Client-Secret` from named environment variables;
Access inserts the signed assertion verified independently by the Worker and DO.
There is no deployed bypass. An `Origin` or `Mcp-Session-Id` header is rejected.

Only verified `service:{name}.access` identities with a separate enabled publisher
grant can access `/ingest/`. Read grants, human OAuth, and `ADMIN_IDENTITIES` do not
imply publisher permission. Publisher grants use the existing allow/deny masks:
`*`, exact workspace slug, and `prefix-*`; deny wins. Authorization, identity
expiry, authority enablement and lease health are rechecked after body streaming
and on every operation. Revocation expires affected held leases immediately.

Every object described below is strict: unknown properties and duplicate JSON keys reject. Integers are
JSON safe integers. Responses have `Cache-Control: no-store`. Success is HTTP 200.
Errors contain only `{"error": STATUS}`: 400 malformed input or invalid manifest,
401 invalid/expired Access assertion, 403 unauthorized, 404 unknown route or
publisher-authorized missing authority, 405 wrong method, 409 state conflict
(lease, revision, reservation, replay, ownership, quota), 429 admission full,
431 oversized headers, 503 unavailable authority. 409/429 carry `Retry-After: 1`.
A 409 after lease acquisition is fatal to that ingestion attempt. Do not infer
whether an external provider write succeeded from an HTTP error here.

Bodies have a 30-second streaming deadline. At most four small administrative or
publisher requests are reading bodies concurrently. Manual import and ingestion
publish and submit share one large-body slot. No transaction is held while awaiting bodies or
network calls. Small publisher bodies are at most 512 KiB; admin provisioning is
at most 128 KiB; publish and submit wrappers are at most 17 MiB.

## Administrator provisioning

`POST /admin/publisher`:

```json
{
  "key": "service:ci.access",
  "grants": { "allow": ["team-docs"], "deny": [] },
  "enabled": true
}
```

`POST /admin/ingestion`:

```json
{
  "workspace": "team-docs",
  "enabled": true,
  "binding": {
    "projectId": "proj_example",
    "credentialEnv": "OPENAI_QUERY_KEY",
    "stores": { "guide": "vs_example" }
  },
  "ownership": {
    "project_id": "proj_example",
    "collections": {
      "guide": {
        "repository": "example/guide",
        "branch": "main",
        "vector_store_id": "vs_example"
      }
    }
  }
}
```

Both return `{"ok":true}`. `enabled` on provisioning is optional, default true.
Repeating exact binding/ownership is idempotent; enablement may change. Disabling
expires the lease, retains all state and store reservations, and denies publisher
reads and writes. Re-enabling does not resurrect the lease. Binding and ownership
are immutable. Credential environment names match `[A-Z][A-Z0-9_]{0,127}` and may
not contain `ADMIN`. No credential values are accepted. Ownership uses the CLI's
existing collection binding shape; `branch` may be null. Repositories are relative
logical names, not local paths. Collection/workspace slugs match
`[a-z0-9]+(?:-[a-z0-9]+)*` and are at most 80 characters. There are 1–20 collections,
unique stores, and exact equality of project and collection/store mappings.

Provision only fresh empty stores and a previously unmanaged workspace. Existing
manual/local publications cannot be adopted. Project/store pairs are reserved
exclusively across ingestion authorities and existing gate workspaces. Every later
manual import checks reservations transactionally. Manual import cannot replace a
managed workspace; unrelated unmanaged imports still work. Failed provisioning
has no partial reservations. The administrator helper supports `publisher` and
`ingestion` commands with a JSON input file.

## Status and read-only publication

`GET /ingest/{workspace}/status` returns:

```json
{
  "workspace": "team-docs",
  "initialized": false,
  "revision": 0,
  "binding": {
    "projectId": "proj_example",
    "credentialEnv": "OPENAI_QUERY_KEY",
    "stores": { "guide": "vs_example" }
  },
  "ownership": {
    "project_id": "proj_example",
    "collections": {
      "guide": {
        "repository": "example/guide",
        "branch": "main",
        "vector_store_id": "vs_example"
      }
    }
  },
  "publication": null,
  "operation_count": 0
}
```

`GET /ingest/{workspace}/publication` returns null before the first publication;
otherwise it returns `{generation,parts,bytes,digest}`. `generation` is the gate's
`o-` plus 64 lowercase hex canonical-manifest hash; `digest` is SHA-256 of the exact
concatenated snapshot bytes. `parts` is 1–16; `bytes` is at most 9 MiB.

`GET /ingest/{workspace}/publication?generation={generation}&part={index}` returns
one raw binary chunk (`application/octet-stream`), at most 900 KiB. Zero-based
indices must exist. Concatenating chunks and decoding UTF-8 once produces JSON
`{projectId,credentialEnv,stores,manifest}`. Verify byte count and digest before
using it. The credential name is metadata, never a credential value. Each request
pins generation and rejects with 409 if it changed. Never concatenate chunks from
different generations. A lease-free planner may restart its read from metadata on
this conflict; it must not acquire a lease or make provider writes. Another
publisher can hold or checkpoint a lease throughout preview. These read-only
requests are network requests, not an offline preview.

## Lease and consistent journal reads

`POST /ingest/{workspace}/lease` accepts exactly one of:

- `{action:"acquire",nonce,request_id}`
- `{action:"renew",epoch,nonce}`
- `{action:"release",epoch,nonce}`

`nonce` is a client-generated cryptographically random 32-byte value encoded as 64
lowercase hexadecimal characters. Only its SHA-256 hash is stored. `request_id` is
a UUID; `epoch` is a positive safe integer. Responses are
`{epoch,expires_at,server_time}`, timestamps in integer Unix milliseconds. Lease
duration is 120 seconds; heartbeat every 30 seconds. Release returns expiry zero.
Acquire retry with the same identity/nonce/request ID preserves the valid lease's
epoch and expiry; server_time is freshly measured. Acquire after expiry/revocation
increments the durable fencing epoch. Different live holders receive 409. Stale
holders cannot renew, release or mutate a later lease.

Before initial acquisition only, clients may wait with cancellation-aware jitter,
respecting Retry-After and a bounded lease-wait-seconds budget (default 300,
0–1800). After acquisition discard prior snapshots, read fresh status and load
current state. Never reacquire in place after losing a lease. Use the acknowledged
remaining duration and a conservative monotonic deadline; do not trust a cached
healthy flag. Any renewal failure permanently poisons the current attempt.

`POST /ingest/{workspace}/snapshot` takes `{epoch,nonce,revision}` and returns the
same metadata shape as status. The revision must equal current authority revision.
It contains no whole-history operations dictionary. Snapshot publications use the
same pinned chunk protocol above.

`POST /ingest/{workspace}/operations` accepts either:

- `{epoch,nonce,revision,ids:[operation_id,...]}` (1–50 IDs); or
- `{epoch,nonce,revision,after:"",limit:100,cleanup:false}` (`after`, `limit`,
  `cleanup` optional, with those defaults).

Response: `{revision,items:[{id,operation}],next}`. Absent lookup IDs are omitted;
lookup results fit one bounded response and `next` is null. Page mode uses lexical
operation-ID keyset ordering. `next` is the last emitted ID if more rows remain,
otherwise null; supply it as the next `after`. Check cursor progress and cycles.
`cleanup:true` selects nondeleted, nonactive operations only. It intentionally
includes unresolved old upload/attach intents; never silently drop them. Each page
checks the current lease and revision. After your own successful checkpoint use
its acknowledged revision on subsequent pages. No concurrent writer may silently
change the snapshot. At most 100 rows and 512 KiB including overhead are returned;
the byte budget stops assembly early when necessary. Do not reconstruct all remote
history in the client: use bounded lookups and streaming cleanup.

## Commands, revision CAS and idempotency

All commands below require `{epoch,nonce,expected_revision,request_id,...}`.
`expected_revision` begins at zero and is a nonnegative safe integer. Each accepted
new command increments it once, including an idempotent initialize or an exact
publication no-op. A retry of the same command UUID and body returns the original
receipt without incrementing revision, provided the same valid lease is held.
The server hashes the command name, one newline, and `canonical(parsed_body)` as UTF-8 SHA-256;
canonical JSON recursively sorts object keys and uses JavaScript JSON string
encoding. Clients do not compute this hash: retain and resend the identical
logical command. This is not the Python local-state checksum. A changed body for
a retained request ID conflicts. Receipts are retained for the latest 256 revisions;
older retry receipts cannot bypass expected-revision CAS after eviction. Lease
renewal is independent of journal revision. State changes and receipts commit in
one SQLite transaction. A lost response requires reconciliation/retry of the same
request, never inventing a fresh ID against guessed state.

`POST /ingest/{workspace}/initialize` has only the common command fields and returns
`{initialized:true,revision}`. The client must first verify all provisioned stores
are empty, under its lease. A repeated initialized authority remains initialized;
this does not reset operations/publication. `update --apply` must reject an
uninitialized authority. Idempotent `index --apply` may resume or converge existing
initialized state. No gate publication exists until publish succeeds.

`POST /ingest/{workspace}/checkpoint` adds mandatory `upserts:[{id,operation}]`
and optional `retire:[{id,retired_id}]`. Their combined length is at most 100.
Response is `{revision}`. Empty deltas are valid. There is deliberately no ownership
record deletion: deleted attempts remain tombstones. The maintenance limit is
100,000 operations per workspace, including tombstones. Quota failure is atomic
and must stop the client before dispatching a new provider intent.

Operation IDs are the producer's opaque 64 lowercase hex hashes, optionally
followed by `.retired.` and 32 lowercase hex characters. The server does not
recompute Python hashes. Operations have exactly these fields:

| Field              | Contract                                                           |
| ------------------ | ------------------------------------------------------------------ |
| collection         | provisioned slug                                                   |
| store              | exact provisioned `vs_` identifier                                 |
| path               | logical path, shared gate path validation, at most 1024 characters |
| version, sha256    | 64 lowercase hexadecimal characters each                           |
| source_commit      | 40 or 64 lowercase hexadecimal characters, non-null                |
| filename           | `wiki-rag-` plus 32 lowercase hex plus `.txt` or `.pdf`            |
| phase              | phase name from the transitions below                              |
| ingestion_attempts | integer 1–3                                                        |
| file_id            | required after upload; absent in upload_ready/upload_pending       |
| terminal_failure   | optional literal true, preserved once recorded                     |

A serialized operation is at most 8 KiB. New operations begin at upload_ready.
Collection, store, path, version, hash, source commit, filename and attempt number
are immutable within an attempt. File IDs become immutable when first set, and
cannot alias another operation or reactivate a retired file. Upload filenames are
uniquely owned within the project, including retired attempts.

Permitted changes (same-phase retransmission is also allowed):

```text
upload_ready -> upload_pending
upload_pending -> uploaded | upload_ready
uploaded -> attach_pending | detach_pending
attach_pending -> attached | uploaded
attached -> complete | ingestion_failed | detach_pending
complete -> detach_pending
ingestion_failed -> detach_pending
detach_pending -> detached
detached -> file_delete_pending
file_delete_pending -> deleted
```

The `upload_pending -> upload_ready` and `attach_pending -> uploaded` transitions
are only for explicit provider rejection known to have had no effect. Unknown
outcomes remain pending for reconciliation. Retirement of active file IDs is
rejected. Only a fully deleted logical operation may be replaced: submit its
`{id,retired_id}` together with a fresh upload_ready upsert at the original ID.
The old deleted receipt is copied atomically to the matching `.retired.{uuidhex}`
key. Fresh attempts need fresh filenames and file IDs. No phase reset can bypass
retirement.

## Atomic publication

`POST /ingest/{workspace}/publish` adds `manifestText` (the exact JSON string in the
existing manifest v1 format); returns `{generation,revision}`. The manifest remains
bounded to 8 MiB, 10,000 files and 20 collections. Its project, repository, branch,
collection and store identities must match provisioning. Remote collection commits
must be non-null. Every file must match a complete owned operation by operation ID,
collection/store, file ID, path, version, content hash and source commit. Normal
manifest schema, binding immutability and publication replay/sequence checks also
apply. Exact manifest resubmission keeps gate generation and reference identity.

The gate chunks, active generation, ingestion active-operation set, journal
revision and request receipt are committed in one synchronous DO transaction.
Any failure preserves the previous publication. Publication is not an OpenAI
transaction: intents/outcomes surround each provider write on the client. An
already dispatched call can complete after lease expiry. Reconcile unique upload
filenames/content hashes and known attachment IDs; ambiguous unknown outcomes
remain explicit unresolved errors. Never claim exactly-once OpenAI mutations or
remote cancellation. Retired IDs cannot be activated by later publications.

Trusted CI publishers also possess project-scoped OpenAI ingestion credentials.
This API fences journal/publication writes, not arbitrary malicious/out-of-band
provider calls. Use trusted protected-branch code. Check lease health immediately
before every mutating HTTP attempt, including retries after DELETE backoff. Failed
checkpoint/renewal or an expired monotonic deadline stops further provider calls.
After committed publication, cleanup failures are still fatal to the attempt;
report the committed publication separately and use a fresh attempt for cleanup.

Source cleanliness, full Git history/forward ancestry, rescan before submit/publish,
empty-store verification and provider outcome reconciliation are client duties.
The server never receives document bodies or repository checkouts. It cannot
independently verify those facts. No legacy adoption or history-compaction API is
included in v1. Deployments, credential setup and GHA activation are separate
operator actions.

## Asynchronous submission extension

`GET /ingest/{workspace}/status` and fenced snapshots advertise
`features: ["async-submit-v1", "file-origin-v1"]` and `job: null` or the latest job metadata.
New clients require this capability before any provider writes. The existing
per-file operation phases, leases, ownership and synchronous publish endpoint
remain compatible with older clients.

`POST /ingest/{workspace}/submit` takes the same fenced command envelope and
`manifestText` as publish. It validates the complete captured manifest, immutable
collection bindings, publication ordering and every referenced operation. Only
`attached` and `complete` operations are eligible; file IDs, versions, digests,
paths and original source revisions must match. The receipt contains `revision`
and a UUID `job_id`. A lost response is replayed with the same request ID and body.
The command records the exact manifest, submitting publisher, binding, epoch,
revision and per-file readiness in SQLite. It never receives an OpenAI key.

Submission does not publish or poll OpenAI. The CLI releases its lease and the GHA
submission step exits with `mode: submitted`; that is acceptance, not index completion.
The reusable GitHub workflow then polls status for that exact job for up to five
minutes and fails on errors or timeout. This observer neither holds the lease nor
cancels the background job when its wait expires.
An already-current snapshot returns `mode: applied` with its stable publication
ID and creates no new job. The publisher status command reports:

```json
{
  "job": {
    "id": "00000000-0000-4000-8000-000000000000",
    "status": "pending",
    "total": 281,
    "completed": 200,
    "created_at": 1790000000000,
    "finished_at": null,
    "duration_ms": null
  }
}
```

Statuses are `pending`, `complete`, `failed`, `superseded` and `revoked`.
Failures carry a sanitized `error` code; completion carries `publication_id`.
Timestamps use Unix milliseconds. Terminal transitions record `finished_at` and
`duration_ms = finished_at - created_at`; legacy terminal jobs keep these fields
null because their completion time was not recorded. Timing fields are stable
between state transitions, including across fenced snapshot reads. Authorized MCP
readers can inspect the latest job as `indexing` in workspace `status`, alongside
the active publication counts. Before the first publication, use publisher status.
Only the latest job is retained per workspace. A subsequent submission replaces
that job's candidate manifest and readiness rows; immutable file ownership remains.

The Durable Object pre-arms its alarm before committing a submission, and re-arms
before provider work. Replays repair scheduling. One alarm multiplexes jobs by
their durable next-run time. Each invocation processes at most one provider page
of 100 files, with a 512 KiB response limit and 10-second fetch deadline. Pagination
cursors/readiness survive restarts; completed pages advance promptly and pending
indexing is checked again after 30 seconds. Retryable transport/429/5xx failures
back off to at most 15 minutes. Jobs expire after 24 hours instead of polling forever.

The alarm uses the existing project query credential only for fixed-origin GETs.
Provider IDs, status, pagination and each owned file's original attributes are
validated. An `in_progress` file stays unready even if its attributes are absent
or partial; every original attribute must match once the file is `completed`,
before it contributes to publication. The provider permits nullable attributes
in its [file response](https://developers.openai.com/api/reference/resources/vector_stores/subresources/files/methods/retrieve).
No fabricated Access identity or extended CI JWT is used: the server
executes a bounded delegation accepted from the submitting publisher. Before
applying each result, it transactionally rechecks job identity, authority binding,
epoch, revision, enablement and publisher grants. A new writer lease or subsequent
same-lease journal mutation supersedes pending work. Revocation or disablement
permanently revokes the job, including across later re-enablement. Network waits
never hold a SQLite transaction.

After all files are verified complete, operation completion receipts, the captured
manifest publication and job completion commit atomically. An error, stale result
or incomplete batch leaves the prior publication active. Background completion
advances the authority/job revision; it never uploads, attaches or deletes files.
Terminal provider failures mark the affected owned operation for the existing
bounded publisher recovery path. Provider cleanup stays with the next publisher
sync/no-op, whose write credential can retire obsolete owned resources. Selected
unpublished operation IDs are retained during that cleanup so interrupted uploads
can resume. Cleanup uncertainty before a new submission preserves the old
publication and fails the attempt explicitly.

## Verified derived-source extension

The `file-origin-v1` capability permits optional strict `origin` objects on
operations and published files. Absence still means ordinary Git-blob provenance.
LFS origin is `{kind: "git-lfs", oid: sha256, size: bytes}`; the OID must equal the
operation/file byte SHA and size is a nonnegative safe integer. Generated origin
is `{kind: "generated", recipe, recipe_sha256, inputs_sha256}`; recipe is a slug
of at most 80 characters and both digests are lowercase SHA-256. Derived published
entries require a non-null source commit.

Origin is part of immutable operation metadata. Submit/publish compare the entire
file origin with the owning receipt, and background readiness also checks the
provider's `source_kind` attribute. It cannot be added, removed or relabeled on an
existing operation. MCP query/get returns the stored origin so a generated logical
path is not confused with an existing Git blob. Source preparation and input proof
remain client responsibilities, described in [derived sources](../../docs/derived-sources.md).

Upgrade the gate first; require the capability before staging or cleanup provider
writes involving derived records. Older strict readers cannot parse publications
with this extension, so do not roll the gate back below this capability while such
publications remain active. Existing issuer, namespace and ownership bindings are
unchanged.
