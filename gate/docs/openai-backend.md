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
Original downloads require both provider downloadability for the file and permission
to GET `/v1/files/{file_id}/content`; permission alone does not guarantee access.
Existing credentials are not automatically expanded. A denied download returns
`ORIGINAL_UNAVAILABLE`. That error alone does not establish a permission failure: file-purpose restrictions and availability can also cause rejection. Failed original downloads now include only HTTP status, a request ID matching the bounded `req_` hexadecimal format, and strict allowlisted provider type/code values. An exact provider message denying `assistants` downloads maps to the fixed `purpose_not_downloadable` classification; arbitrary messages are never returned. Diagnostic JSON reads are capped at 8 KiB within the existing request deadline. Malformed/oversized bodies and unknown fields are discarded, not echoed. No automatic retry or credential/purpose substitution occurs.

The ingestion CLI uploads with `purpose="assistants"`. A live acceptance check on
2026-11-12 returned HTTP 400, `invalid_request_error` and
`purpose_not_downloadable` for an existing text file. This confirms a provider
purpose restriction for that read, not missing permission. Current assistants-purpose
uploads may therefore reject original downloads; granting Files-read permission
is not an established fix. Use parsed retrieval or an accessible local source.
Do not automatically change upload purpose, reindex or expand credentials.
The [Files content reference](https://developers.openai.com/api/reference/resources/files/methods/content)
documents the endpoint; the [API debugging guidance](https://developers.openai.com/api/reference/overview)
explains request IDs. Reconciliation code and synthetic tests do not establish
live original download support. Keep this acceptance boundary separate from
successful parsed retrieval.
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

## Published-path discovery

Use `find_documents({workspace, query, repository?, limit?})` for a known filename
or literal path fragment in one explicitly authorized OpenAI workspace. Prefer
local filename discovery and source reads when a suitable checkout is accessible.
`query` is trimmed and must contain 1-1024 characters; it matches the entire
remaining string using `toLowerCase().includes()`, without Unicode normalization,
tokenization, regex or glob interpretation. Hyphens and underscores differ.

Optional `repository` uses the manifest repository identity rules: 1-256 characters,
no controls, leading slash, backslash, empty slash segments, `.` or `..` segments.
It is compared exactly and case-sensitively, without trimming or normalization,
before matching, ranking and limiting. Unknown repositories return zero results
without suggestions. `workspace` is a single exact slug, with no default or masks.
An unknown or ungranted workspace returns `ACCESS_DENIED`; an authorized unavailable
publication returns `NOT_FOUND`. QMD or an absent backend capability returns the
fixed `UNSUPPORTED_OPERATION` error without initializing native search.

The active validated manifest supplies all candidates, without document-body reads,
provider requests, models or a separate index. Order is exact basename, basename
containing the fragment, then remaining path matches. Ties use original repository,
collection and path in code-unit order. Distinct paths or repositories remain
separate; filename matches do not establish canonical ownership or approval.

`limit` is an integer 1-20, default 5; invalid values are rejected. Results contain
`ref`, `workspace`, `generation`, `collection`, full `path`, basename `title` and
canonical `source` provenance, including nullable commits and optional `origin`.
Only the display title is capped at 500 UTF-16 code units; ranking, paths and refs
retain the full basename. `source.lineBasis` is `none`. No snippet, body, score or
provider/store IDs are exposed.

The response is `{results, hasMore}`. `hasMore` is true exactly when matches were
omitted by the limit; there is no total count, cursor or pagination. Narrow the
fragment, supply a known exact repository or increase the limit to 20. Repeated
calls on one generation return the same prefix. The repository filter prevents
other repositories from consuming the result cap, but does not guarantee exhaustive
reachability within a repository. `hasMore=false` covers matching published paths
only, not repository or corpus completeness. Zero matches is a successful empty
result with `hasMore=false`, without content-search fallback or hidden suggestions.

The existing 65,536-byte UTF-8 JSON payload budget also applies to discovery; this
is not a complete MCP-envelope bound. Overflow returns `CONTENT_TOO_LARGE`; reduce
the limit. Responses use the existing single JSON text block. `get` and `multi_get`
accept discovery refs and reauthorize them: revoked access fails and an older
generation returns `NOT_FOUND`, even if the path remains. Grant or generation
changes during discovery suppress both results and operation errors; publication
changes return `CONFLICT`. Discovery grants no local filesystem authority and does
not guarantee that a later provider original-byte download will be permitted.

## Validation and retrieval limits

Imports accept at most 8 MiB, 20 collections and 10,000 files per workspace. Collection
names must satisfy gate lowercase slug rules; reference paths must satisfy existing
gate path rules. Unsupported producer names/paths are rejected, never normalized.
Strict schema checks reject unknown fields, duplicate JSON keys, malformed IDs,
inconsistent stores/paths, ambiguous file mappings and unpublished generations.
SHA-256/version and Git commit syntax are validated; the gate trusts the producer's
hashes during import and parsed retrieval. Original downloads verify their bytes
against the published SHA-256 before returning content. Null `source_commit` is valid
working-tree provenance. Native PDF metadata and per-file preprocessing are retained.

Search requests at most 50 chunks per collection, matching the [provider search
reference limit](https://developers.openai.com/api/reference/resources/vector_stores/methods/search),
with no search pagination. Hits
are filtered by active store/file membership before snippets are returned. Provider
filenames/attributes cannot override canonical paths or repositories. Query is
**document discovery**: each active document receives one complete excerpt from its
first provider-ranked hit. The hit's text parts are joined in provider order, and
`snippet` contains that full text once, without an 800-character clip. Later hits
for the same file are intentionally omitted; use `get` for full available content.
No source offsets are invented. First appearance determines collection
reciprocal-rank ordering (k=60); identical content in distinct repositories stays
distinct. Cross-workspace ranking retains the existing gate reciprocal-rank policy.
Filtering can underfill results; exhaustive recall and full context are not promised.

Search does not fetch every document body or invoke an LLM. The 64 KiB logical
query response budget includes one excerpt and metadata per selected document;
exceeding it returns `CONTENT_TOO_LARGE`, never a clipped result. The document
limit remains 1-20. Many hits for one file no longer accumulate into an oversized
result, but a single very large provider excerpt or up to 20 selected documents
can still exceed that explicit budget. Reduce the result limit or narrow the
query/workspace; an individually oversized excerpt requires a local source.

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

## Document representations

`get(ref, format="parsed")` and `multi_get(refs, format="parsed")` default to the
complete available parsed text. The gate resolves the exact active manifest file
before requesting `/vector_stores/{store}/files/{file_id}/content`, and joins text
parts with newlines without guessing about provider overlap. Returned line numbers
are **parsed text** lines, not original Git or PDF coordinates.

Optional `fromLine` (get only, default 1) and `maxLines` (1-200) preserve explicit
range reads. Without `maxLines`, all remaining lines are returned. `complete` means
the whole available parsed document was returned, not merely the requested range;
`nextLine` is the next parsed line or null at EOF. Starting beyond EOF returns empty
text, `complete: false`, and `nextLine: null`. A trailing newline counts as an empty
last line. `multi_get` starts each document at line 1, uses one shared format and
optional range limit, preserves order and duplicates, and authorizes all references
before any download. It fails as a whole on any read error or aggregate overflow.

Explicit partial HTTP responses (206 or Content-Range) fail with
`INCOMPLETE_CONTENT` on every provider read/search path, including JSON responses
whose `has_more` is false. A provider `has_more=true` parsed response also fails
with `INCOMPLETE_CONTENT`: the documented content
API has no qualified continuation request parameter. A local line range cannot
complete such a provider response. Unsupported parsed shapes fail explicitly with
`UNSUPPORTED_CONTENT` and suggest original format or a local source. `complete: true` means the full content available
from that provider endpoint, not proof of extraction fidelity to the original file.

`format="original"` uses the official [Files content endpoint](https://developers.openai.com/api/reference/resources/files/methods/content)
for the immutable manifest's file ID, when the provider permits downloading it.
Callers cannot supply file IDs. Successfully downloaded bytes must
match `source.sha256`; mismatch returns `CONTENT_MISMATCH` without content. Partial
HTTP responses are rejected. Uploaded UTF-8 text is decoded without altering BOM,
newlines or Unicode; encoding `text` as UTF-8 reproduces the downloaded bytes.
Native PDFs remain binary. Ranges with original format are rejected. QMD originals
are unsupported (`UNSUPPORTED_FORMAT`); its parsed reads remain supported.

Both formats retain canonical source provenance. `source.sha256` always identifies
**uploaded original bytes**, never parsed text or excerpts. Successful original responses add
`sha256`, `byteLength`, `mimeType`, `representation` (`original-text` or
`original-binary`), `format` and `complete: true`. MIME derives from the published
preprocessing/kind: native PDF is `application/pdf`, Markdown is UTF-8
`text/markdown`, and other uploaded text is UTF-8 `text/plain`. Original source line
basis is `original-text` for text and `none` for binary.

Successful MCP calls serialize their payload once as JSON in the first text
content item, omitting `structuredContent`. None of the tools advertises an
`outputSchema`; the [MCP tool-result contract](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#tool-result)
supports text content without structured output. Clients must parse that JSON
text to read the payload; clients depending exclusively on `structuredContent`
must migrate. Tool errors retain `isError: true` and their existing text error.

Binary originals are standard MCP embedded resources with `{uri, mimeType, blob}`;
`blob` is base64 and appears exactly once per binary document in the tool's
`content`. The JSON text contains metadata and the resource URI/MIME, never binary data.
The URI is the canonical `qgdoc:` reference, not a downloadable public URL or
credential. The gate does not advertise a separate resources/read endpoint; repeat
`get` to download again with fresh authorization. Every format retains current-grant,
token and generation checks before access and before delivery.

The pinned MCP TypeScript SDK 1.32.2 supports this [embedded resource representation](https://github.com/modelcontextprotocol/typescript-sdk/blob/1.32.2/docs/server.md).
Tests validate complete text and bytes through the official native HTTP client
and Cloudflare MCP handler/result schema, including multi_get. This qualifies the
protocol; live cloud-connector forwarding and application attachment UI require
separate acceptance. Clients must consume embedded `resource.blob`
content to save binary files; text-only clients should use parsed format or their
local file tools. Live binary acceptance remains blocked by the observed original
download restriction; no live binary read was attempted after the text-file denial.
Codex/Claude attachment rendering is not qualified here.

Each provider response (JSON envelope for parsed/search, raw bytes for original)
is bounded to 2 MiB; a get/multi_get logical result is bounded to 4 MiB, including
base64 and metadata. MCP text encoding and resource metadata can add serialization overhead,
so 4 MiB is not a total HTTP wire limit. Larger originals require a local/source
route; parsed ranges still fetch the complete provider response and cannot bypass
its 2 MiB bound. Excess size returns `CONTENT_TOO_LARGE` with recovery guidance,
never a partial document. Provider requests have a 15-second deadline and workspace
retrieval a 30-second bound; existing queue limits remain. Provider/state errors
are sanitized; only fixed reviewed explanations are public. No provider error
body or credential is returned.

OpenAI `status` counts active imported documents and returns `vectors: null`; it
does not report live provider health or an authoritative embedding count. QMD keeps
numeric vector counts. No re-ingestion, chunk/overlap/embedding change, manifest
migration or grant change is required for parsed retrieval. Unavailable originals
require a separately reviewed provider/source strategy; permission expansion is
not an automatic remedy.

## Choosing and measuring retrieval

A remote index is useful when the source checkout is unavailable or the question
spans repositories. An available local checkout can answer source and documentation
questions directly; remote-first is not an inherent cost or latency advantage.
Use project policy to choose the route. Check source revisions when the distinction
matters, and avoid repeating the same evidence through remote and local reads
unless a specific uncertainty requires it.

For remote retrieval, select the required workspaces explicitly. Use the smallest
result set that covers the question, and fetch only missing context with exact
returned references. `lex` is a built-in alternative for keyword-heavy questions,
but its OpenAI weights do not promise literal matching or equal answer quality.
A fixed query budget can reduce calls while losing necessary evidence; missing
required facts are a failed result, not a cost saving.

The current implementation has distinct model-output and provider-work boundaries:

- `src/gateway.ts` returns one uncut first-ranked OpenAI excerpt per document;
  the response budget errors explicitly if the selected results do not fit.
- `OpenAIBackend.search` in `src/openai.ts` requests 50 chunks per collection,
  then retains the first hit per active document and applies the requested result limit. Reducing
  `query.limit` reduces returned results, not that provider request bound.
- `OpenAIBackend.read` fetches a complete parsed document before the gateway
  optionally slices explicitly requested lines. `multi_get` reads serially from
  each document start; omitted range limits return full available content.
  Smaller line limits reduce the returned text, not the full-document provider read.
- `src/http.ts` supplies both MCP text content and structured content. Code-mode
  callers should display one text representation rather than serialize the entire
  envelope and repeat the same result. Binary resource bytes are emitted once.
  This does not change provider work.

These are source-level explanations, not measured attribution of elapsed time or
money. This retrieval contract needs controlled quality/efficiency measurement;
implementation tests alone do not establish a latency or token saving.

Compare complete answers against the practical local route on the same relevant
source revision, model/effort, tool contract and output budget. Count real inner
tool invocations, retries and follow-up reads; grade required evidence and
correctness independently of timings. Record total input, cached input and output
separately. Fewer bytes, calls or uncached tokens alone do not establish lower
monetary cost; attributable runtime and provider charges are required. Preserve
unavailable measurements and corpus mismatches as limitations.

### Lessons from other retrieval systems

Primary-source review on 2026-11-12 found useful patterns, not a replacement
backend or a demonstrated saving. Context7's public
[MCP adapter](https://github.com/upstash/context7/blob/681554c5d3a688c67879d02d4f01d79ffd15df13/README.md)
does not include its hosted parser, crawler or search backend. Its
[one-request Search API](https://context7.com/docs/api-reference/search/search-documentation-in-one-request)
combines library selection, retrieval and global reranking. Its separate
[context API](https://context7.com/docs/api-reference/context/get-documentation-context)
can skip LLM reranking with `fast=true`, with an explicit relevance tradeoff.
These are Context7 service features, not options on this gate's OpenAI adapter.
Requested documentation versions can also fall back; check the served-version
metadata rather than assuming a requested version proves exact-source currency.

[Obsidian Search](https://github.com/obsidianmd/obsidian-help/blob/8310cf215a732cb9ec76f18e1691401c7c780b30/en/Plugins/Search.md)
supports path, property and line/block/section scoping. Its native
[CLI](https://obsidian.md/help/cli) can return matching-line context from a vault,
but requires the installed application and registered CLI. These mechanisms
support the value of precise scope and useful match context; they are not this
gate's query grammar. No Obsidian integration or alternate index is installed by
this guidance. Evaluate built-in provider controls before adding a parser,
reranker, cache or new service, and preserve authorization and provenance.

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
