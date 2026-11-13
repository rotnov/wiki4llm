# Wiki RAG Gate

The authenticated MCP gateway component of wiki4llm for published OpenAI Retrieval workspaces, with QMD compatibility. QMD workspaces have separate SQLite indexes and share one lazily initialized model runtime. OpenAI workspaces use explicitly imported published manifests. Run the commands below from `gate/`. For the recommended hosted stack, start with
[the deployment guide](../docs/deployment.md); for Worker operations, see
[Cloudflare deployment](docs/deployment.md).

## Quick start: OpenAI Retrieval

Requires Node 24 or newer. Tested on macOS with Node 26.12.0. First publish a
synthetic or authorized repository snapshot using the `wiki-rag` CLI in the repository root.
Supply its project and collection/store IDs explicitly below, and make the named
project query credential `WIKI_RAG_QUERY_KEY` available in the serving environment.

```sh
npm ci
npm run build
node dist/src/cli.js import-openai --id docs \
  --manifest /absolute/path/to/manifest.json \
  --project proj_example --credential-env WIKI_RAG_QUERY_KEY \
  --store guide=vs_example
node dist/src/cli.js principal --id reader --allow docs
node dist/src/cli.js token --principal reader --name local-agent --out .data/reader.json
npm start
```

Repeat `--store` for each published collection. Repeat the explicit import after a
producer update. See [docs/openai-backend.md](docs/openai-backend.md) for the strict
publication contract, parsed-content limits and opt-in synthetic qualification
runner. An OpenAI-only gate does not initialize the native QMD runtime.

Connect a Streamable HTTP MCP client to `http://127.0.0.1:8787/mcp` with `Authorization: Bearer {secret}` from the generated credential file. Credentials are printed only to that new file, mode 0600. The database stores SHA-256 hashes, not token values. Keep the credential file private. The default server rejects browser Origins, unexpected Host headers and all session IDs. Container mode adds an explicit bind address and exact authority allowlist; it does not disable bearer authentication.

## QMD compatibility

Local QMD sources remain supported in separate workspaces through the same tools:

```sh
node dist/src/cli.js workspace --id team-a --source docs=/absolute/path/to/docs
node dist/src/cli.js principal --id team-a-reader --allow 'team-a,team-a-*'
node dist/src/cli.js index --id team-a
node dist/src/cli.js token --principal team-a-reader --name local-agent --out .data/team-a.json
```

For QMD workspaces, use `query` with `mode: "lex"` for the model-free smoke test. `index --embed` additionally downloads and runs QMD embedding models. `vec` uses vectors with query expansion; `hybrid` (the default) also reranks candidates. These modes can load additional models. The default suite qualifies real lexical retrieval. Optional model qualification is available through `npm run test:models`; it is not a retrieval-quality or throughput benchmark. GPU memory consumption and the deployment platform require their own qualification.

Every command accepts `--state /absolute/path/to/state` (default `.data`). `serve` accepts `--port` (default 8787), `--bind` (127.0.0.1 by default; 0.0.0.0 for containers), and repeatable `--authority` values for an exact Host allowlist. `index --id team-a` indexes one workspace; omit `--id` to index all QMD workspaces through one runtime. Repeat `--source collection=/path` to register several collections in a workspace. Re-registering a workspace replaces its source list; index again to publish the new content.

## Access administration

```sh
node dist/src/cli.js principal --id reader --allow 'team-a,team-a-*' --deny 'team-a-secret'
node dist/src/cli.js token --principal reader --name limited --allow team-a --days 7 --out .data/limited.json
node dist/src/cli.js revoke --id {token-id}
node dist/src/cli.js principal --id reader --disabled
```

Principal edits replace all rules. `*` grants all registered data workspaces; `team-a-*` grants descendants, not `team-a` itself. Deny overrides allow. Optional token rules intersect principal rules, never enlarge them. Expiry defaults to 30 days and is limited to 365 days. Each request checks current policy; revocation and grant removal also prevent release of an in-flight result. There are no remote administrative tools: filesystem ownership of the state directory is the administration boundary. An owner data token cannot issue credentials or modify grants.

## MCP contract

Authenticated native and Worker POST requests accept standard MCP `ping`. The SDK returns the matching request ID with an empty `result`, without invoking data handlers or providers. Ping grants no corpus access; existing authentication, request limits and stateless handling are unchanged. GET `/mcp` remains unsupported (405).

Successful calls return one JSON payload in the first `content` item (`type: "text"`), without a duplicate `structuredContent` field. Tools do not advertise `outputSchema`. Consumers that previously read `structuredContent` must parse the JSON text instead. Binary originals add an embedded resource per binary document; bytes occur only in its `resource.blob`, while the JSON payload retains metadata and the resource URI/MIME. Tool failures retain `isError: true` and a text error, which is not a JSON success payload. Native SDK and Worker transport tests cover this contract; individual cloud connectors and attachment interfaces still require live acceptance.

Native and Worker `tools/list` advertise Zod input schemas: defaulted arguments may be omitted, and the server applies their documented defaults. Required query text, document references and the exact `find_documents.workspace` remain required. Unknown fields are rejected.

| Tool              | Purpose                                                     |
| ----------------- | ----------------------------------------------------------- |
| `list_workspaces` | Paginated authorized workspace names and indexed state      |
| `find_documents`  | Literal published-path lookup in one OpenAI workspace       |
| `query`           | Search authorized workspaces using `lex`, `vec` or `hybrid` |
| `get`             | Read an exact workspace/generation-qualified reference      |
| `multi_get`       | Read an explicit bounded list of qualified references       |
| `status`          | Authorized workspace document/vector counts                 |

`list_workspaces` accepts `limit` 1-50 (default 20) and `offset` 0-100000 (default 0). Pass the returned `nextOffset` as the next request's `offset`; `null` marks the final page. `query.limit` remains 1-20 (default 10). Optional `query.includeSnippets` defaults to `true`; `false` omits entire snippet fields and adds `snippetsIncluded: false` for metadata-only discovery before separate source reads. References, provenance, ranking and provider requests remain unchanged. `get` and `multi_get` default to `format="parsed"`, returning the complete available parsed text. Optional `get.fromLine` is one-based, 1-1000000 (default 1); optional `maxLines` 1-200 bounds explicit parsed ranges, otherwise all remaining lines are returned. `format="original"` requests verified uploaded bytes when the provider permits download, with binary files in embedded MCP resources; ranges are rejected. Current assistants-purpose uploads may reject downloads; use parsed retrieval or a local source. `multi_get` accepts 1-20 references. Parameter descriptions and tool-level prose both expose these bounds for clients that flatten input schemas. Use source repository and relative path to find an accessible local checkout first; read it with your own tools and identify revision differences. Remote reads are the fallback when no suitable local source/tool exists. See [retrieval representations and limits](docs/openai-backend.md#document-representations) for completeness, hashes and binary client support.

`find_documents` requires one exact authorized `workspace` and a trimmed literal
`query` (1-1024 characters). It searches only published paths, case-insensitively;
no bodies, provider requests, regex, globs or word expansion. Optional `repository`
is an exact case-sensitive identity (1-256 characters), filtered before ranking and
limiting. `limit` is 1-20, default 5. `hasMore` reports omitted matches; narrow the
fragment or repository, or increase the limit. There is no pagination. An empty
result means no matching published paths, not an incomplete repository diagnosis.
QMD discovery returns `UNSUPPORTED_OPERATION`; existing QMD tools are unchanged.
Use returned refs with `get` or `multi_get`. See the [metadata discovery contract](docs/openai-backend.md#published-path-discovery)
for ordering, provenance and publication boundaries.

For `query` and `status`, omitted workspace selection uses all effective grants, up to 20. Empty selection is rejected. An explicit unauthorized name rejects the entire request; masks expand only within effective grants. Results retain workspace, generation, collection, relative path and provider-specific source provenance. OpenAI status reports an unknown vector count as `null`. Cross-workspace ranking uses reciprocal per-workspace rank, not raw BM25 scores. Identical documents in different workspaces remain separate results.

The existing `qgdoc:` document-reference and `qg_` token wire formats remain stable. Document references are untrusted locators, not bearer credentials. Every read re-authorizes them. Raw QMD short IDs, filesystem paths, fuzzy reads and arbitrary glob reads are not supported. Reindexing creates a fresh generation; old references become invalid and must be refreshed by querying or finding documents again.

## Persistence and indexing

The state directory contains `gate.sqlite`, `indexes/{workspace}/{generation}/index.sqlite`, copied source snapshots, and `models/`. Preserve the **entire directory** across restarts or mount it as persistent storage in a future container. Back it up while the service is stopped. Docker Compose packaging and its persistence smoke test are described in [docs/containers.md](docs/containers.md). Cloud deployment is a separate operator action.

QMD indexing and serving are mutually exclusive through `.process-lock`. Stop serving, index, then restart. A failed workspace build leaves its previous published generation intact. Multiple workspaces publish separately, not as one transaction. Old generations remain on disk; there is no automatic garbage collection. After a crash, inspect `.process-lock/owner.json` and confirm the owner is no longer running before manually removing the lock.

QMD sources are trusted, operator-selected local directories. Only non-hidden Markdown/MDX files are ingested; symlinks are rejected, and `local-evidence`, dependencies and build directories are excluded. Keep sources stationary during indexing. Limits: 1 MiB per document, 256 MiB and 10,000 documents per collection. Git hooks and update commands are never executed. The QMD backend rebuilds a fresh index. The reusable GitHub workflow and incremental remote ingestion target the OpenAI backend.

Requests are limited to 128 KiB. Logical tool results are limited to 64 KiB for list_workspaces/find_documents/query/status and 4 MiB for get/multi_get; excess returns an explicit error, never silent truncation. Workspace discovery returns at most 50 names per page; search/status selection remains limited to 20 workspaces, search to 20 results, and reads to 20 documents (full by default, explicit parsed ranges at most 200 lines per document). One expensive operation runs at a time, with 16 waiting slots and a 120-second deadline. Cancellation suppresses the response but cannot forcibly interrupt native inference; the slot stays occupied until native work finishes, including during shutdown.

## Integration boundary and verification

QMD 2.8.3's public store factory creates one model runtime per store. `src/qmd.ts` therefore uses a narrow, version-guarded private seam to inject one runtime into separate internal stores and the default tokenizer runtime. Store closure does not own model disposal. Upgrades require requalification. Shared object identity and synthetic vector/hybrid inference are tested; shared VRAM usage has **not** been measured. SQLite files separate retrieval state, not OS process privileges.

```sh
npm run check
npm run build
npm test
npm run format:check
npm audit
# Optional: downloads roughly 2.1 GiB of model weights on first run.
npm run test:models
# Build and qualify the Docker Compose deployment locally.
docker compose build
npm run test:compose
```

The suite covers policy, credential persistence/revocation, cross-workspace reads, cancellation/queue limits, real QMD lexical indexing, official MCP client requests, CLI administration, atomic OpenAI manifest imports, active-ID filtering, parsed content and mixed backend routing. Native dependency installation varies by platform; review npm's package-specific install-script requests rather than globally disabling install-script protections.

The [runtime architecture](docs/architecture.md) describes the native/QMD design. Hosted Access bootstrap and account-specific acceptance are documented in [the Worker deployment guide](docs/deployment.md).

## Optional Cloudflare target

The OpenAI-only Worker + SQLite Durable Object target uses Cloudflare Access Managed OAuth and an explicit identity-to-principal mapping. The Node/QMD target remains available. See [Cloudflare runtime](docs/cloudflare.md) for local workerd tests, operator bootstrap, bounds and the separate hosted acceptance gate.

Remote ingestion authority for ephemeral producers is documented in the [ingestion protocol](docs/ingestion-state-protocol.md). It adds service-only publisher routes, durable fenced leases, bounded operation deltas and atomic gate publication. It requires a fresh administrator-provisioned authority; deployment and consumer workflow activation remain separate operator actions.
