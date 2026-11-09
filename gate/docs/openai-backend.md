# Local OpenAI Retrieval backend

The gate accepts schema-version-1 publications from the independent `wiki-rag`
ingestion CLI. It does not ingest repositories, read the producer's private journal,
or share its SQLite schema. `src/manifest.ts` owns validation; `State.importOpenAI`
in `src/state.ts` owns the atomic snapshot and authority binding. `src/router.ts`
selects the provider per workspace and loads native QMD only when requested.

## Explicit publish-to-gate step

After the producer publishes `manifest.json`, import that entire snapshot locally:

```sh
node dist/src/cli.js import-openai --state .data --id docs \
  --manifest /absolute/path/to/manifest.json \
  --project proj_example --credential-env WIKI_RAG_QUERY_KEY \
  --store guide=vs_example --store second=vs_other
```

Supply each collection/store binding explicitly. The environment variable name is
stored; its value is read only by the serving process. Provision a project-scoped
query credential with vector-store search and parsed-content read permissions.
Never supply an organization admin key. The CLI does not accept a key value, base
URL, custom HTTP headers or public write tools. The provider origin is fixed to
`https://api.openai.com/v1`, with an `OpenAI-Project` header and redirects disabled.

The first import binds project, collection/store map and credential variable to the
workspace. Later imports cannot silently change that authority. Use a newly named
workspace and deliberate grant changes when reprovisioning. Existing QMD workspaces
cannot be converted. The default local `index` command skips OpenAI workspaces;
explicitly indexing one is an error.

Imports use `BEGIN IMMEDIATE` to compare and replace bindings, snapshot and generation
in one SQLite transaction, including between concurrent CLI processes. They may run
while the gate serves requests. A failed import preserves the prior snapshot. Lower
producer generations, changed content at the same generation and reused publication
identities are rejected. The content-derived gate generation includes publication
identity; whitespace/key order changes do not invalidate references. An unchanged
publication preserves references. A changed publication invalidates all older workspace
references. Each request retains its first workspace snapshot across all references,
and an in-flight generation change prevents delivery.

The imported database is authoritative. Subsequent producer changes become visible
only after another explicit import. This describes the native import path. The [Cloudflare runtime](cloudflare.md)
supports atomic remote publication and Access OAuth; the repository-root
[GitHub workflow](../../docs/github-actions.md) provides ingestion automation.

## Validation and retrieval limits

Imports accept at most 8 MiB, 20 collections and 10,000 files per workspace. Collection
names must satisfy gate lowercase slug rules; reference paths must satisfy existing
gate path rules. Unsupported producer names/paths are rejected, never normalized.
Strict schema checks reject unknown fields, duplicate JSON keys, malformed IDs,
inconsistent stores/paths, ambiguous file mappings and unpublished generations.
SHA-256/version and Git commit syntax are validated; the gate trusts the producer's
hashes and does not re-fetch source bytes to verify them. Null `source_commit` is valid
working-tree provenance. Native PDF metadata and per-file preprocessing are retained.

Search requests at most 50 chunks per collection, matching the [provider search
reference limit](https://developers.openai.com/api/reference/resources/vector_stores/methods/search),
with no search pagination. Hits
are filtered by active store/file membership before snippets are returned. Provider
filenames/attributes cannot override canonical paths or repositories. Repeated chunks
are collapsed before collection reciprocal-rank ordering (k=60); identical content
in distinct repositories stays distinct. Cross-workspace ranking uses the existing
gate reciprocal-rank policy. Filtering can underfill results; exhaustive recall is
not promised. Search chunks supply snippets without fetching every document body.

Modes set OpenAI `ranking_options.hybrid_search` embedding/text weights:

| Mode     | Embedding weight | Text weight |
| -------- | ---------------- | ----------- |
| `lex`    | 0                | 1           |
| `vec`    | 1                | 0           |
| `hybrid` | 1                | 1           |

These are OpenAI retrieval weight controls, not QMD/BM25 equivalence or a quality
benchmark. The producer qualification accepted all three mappings against a real
synthetic project on 2026-11-08; this change's deterministic tests validate request
construction. Live gate qualification is a separate operator-run step.

`get` resolves the exact active file before requesting parsed content. It joins text
parts with newlines; returned line numbers describe **parsed text**, not original Git
or PDF lines. Responses with `has_more=true` fail explicitly: the content API's
continuation request protocol has not been qualified. No partial page is presented as
a complete document. Each provider response and complete parsed document is bounded
to 2 MiB, requests to 15 seconds and a workspace retrieval operation to 30 seconds.
Abort signals propagate through HTTP. Existing tool output and queue limits still
apply. Provider errors are sanitized, without credentials or response bodies.

Provenance includes backend, repository/path, known source/repository commits,
publication ID, uploaded-byte hash, file kind and parsed-line basis. OpenAI `status`
counts active imported documents and returns `vectors: null`; it does not report live
provider health or an authoritative embedding count. QMD keeps numeric vector counts.

## Verification and opt-in synthetic driver

`npm test` includes the official MCP SDK against a real local HTTP listener, fake
OpenAI HTTP responses, real QMD lexical indexing, and a subprocess driver test that
imports, serves, updates, restarts and revokes credentials. The committed fixture was
generated by the reviewed producer at `62791c824c0277cb585b0102e0524ed7354769d4`, using
its `tests/test_engine.py:FakeProvider` and public `run`/`load_config` interfaces.
It contains two synthetic repositories with `README.md`, one working-tree RST file
and a fake-provider-only PDF identity. It contains no credentials or actual corpus.

For live qualification the operator creates temporary synthetic resources and runs
`npx tsx scripts/qualify-openai.ts` with these environment variables:

| Variable                     | Meaning                                                         |
| ---------------------------- | --------------------------------------------------------------- |
| `GATE_LIVE_OPENAI`           | Must equal `1`                                                  |
| `GATE_LIVE_PROJECT`          | Expected synthetic project ID                                   |
| `GATE_LIVE_KEY_ENV`          | Name of the query credential environment variable               |
| Named key variable           | Temporary project query credential value                        |
| `GATE_LIVE_MANIFEST`         | Initial complete publication                                    |
| `GATE_LIVE_UPDATED_MANIFEST` | Initially absent; operator atomically creates after update      |
| `GATE_LIVE_READY_FILE`       | Initially absent; driver atomically writes after initial checks |
| `GATE_LIVE_REPORT`           | Bounded JSON result with check names and no bodies/secrets      |
| `GATE_LIVE_STATE`            | Fresh private local gate state directory                        |
| `GATE_LIVE_QUERY`            | Synthetic phrase matching both repositories' README files       |

The driver initializes an actual MCP client, lists tools, checks modes/query/get,
source provenance, document counts, unknown vectors, denied workspace access and
no-op reference stability. The denied workspace intentionally shares the synthetic
snapshot; this checks authorization, not independent-content isolation. After the
ready marker, the operator updates the producer and supplies the second manifest.
The driver checks stale references, queries and reads every current README, compares
at least one manifest-changed README body with its initial parsed text in memory,
and checks real server restart/persistence and token revocation. Synthetic documents
must fit within 200 parsed lines, and the updated publication must change at least
one existing README byte hash. Bodies never enter reports. Visibility and update waits are each bounded to 240 seconds.
It attempts to stop local server processes and unconditionally revokes its gate
token, closes SQLite and removes its signal handlers even after abnormal child exit. The
operator retains responsibility for deleting all temporary cloud resources and keys.
