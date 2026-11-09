# Gate architecture and source map

The gate exposes the same five read-only MCP tools through two runtimes. The
OpenAI-backed Cloudflare deployment is the recommended hosted path; the native
Node target also supports QMD. See [deployment](deployment.md) for installation,
[Cloudflare contracts](cloudflare.md) for operational boundaries, and
[OpenAI retrieval](openai-backend.md) for content and ranking limits.

## Shared behavior

- `src/gateway.ts` owns workspace selection, request-stable snapshots and tool
  dispatch. Readers are authorized before content delivery, including after
  asynchronous work or a generation change.
- `src/policy.ts` owns allow/deny masks and grant intersection. Workspace names are
  authorization boundaries; collection names distinguish sources within one workspace.
- `src/manifest.ts` validates published OpenAI manifests and publication ordering.
  Canonical source identity includes repository and path, so equal filenames in
  different repositories do not collide.
- `src/openai.ts` reads only IDs in the active published snapshot. Staged or retired
  provider files are not made readable merely because provider search returns them.
- `src/queue.ts`, `src/lease.ts` and the runtime adapters bound work and coordinate
  lifecycle. Their source/tests own exact limits and failure behavior.

## Cloudflare Worker and Durable Object

`src/cloudflare/worker.ts` validates the public route and Access assertion, then
forwards to the private fixed `authority-v1` DO. The DO verifies the assertion
again. `access.ts` owns exact issuer/audience, signature and expiry checks;
`state.ts` owns reader identities, grants and chunked publications.

`ingestion.ts` owns provisioned workspace bindings, independent publisher grants,
durable leases, revision-CAS operation checkpoints, receipts and atomic publication.
Publishers are service identities. Human reader OAuth and administrator privilege
remain separate. Query credentials are Worker secrets, not caller-provided tool
arguments. `mcp.ts` adapts the official MCP SDK to the shared gateway.

The Worker bundle contains no native QMD, filesystem, Node HTTP or local SQLite
runtime. OpenAI owns vector indexing; the DO owns journal/publication authority.
The [ingestion protocol](ingestion-state-protocol.md) is the exact producer contract.
External provider writes are outside its transaction and may finish after a lease
expires; ownership receipts and fresh IDs make recovery explicit.

## Native Node and QMD compatibility

`src/http.ts` serves Streamable HTTP with hashed local bearer credentials.
`src/state.ts` persists native policy and imported manifests in SQLite;
`src/cli.ts` exposes filesystem-owner administration. This credential system is
separate from Cloudflare Access and cannot authenticate the Worker.

`src/qmd.ts` pins QMD 2.8.3 and manages separate indexes with one lazy model runtime.
Its version-guarded adapter accounts for the upstream store closure's ownership of
models and shutdown. Indexing and serving share the native process lease. QMD
rebuilds a generation, while OpenAI manifests may be imported atomically.

Shared model objects do not establish measured GPU-memory savings. Use the
optional model/Compose qualification and target-host measurements before making
hardware or throughput claims. Native/QMD data volumes, model caches and generated
tokens are operator resources; none are included in this public repository.

## Verification routes

- `test/policy.test.ts`, `test/gateway.test.ts`: grants, isolation and tool behavior.
- `test/openai*.test.ts`: manifest import, active-ID filtering and provider boundaries.
- `test/cloudflare/*.test.ts`: real workerd authentication, storage, leases and rollback.
- Repository-root `tests/test_workerd.py`: Python/Worker recovery across fresh runners.
- `scripts/check-worker-bundle.ts`: native-free bundle boundary.
- `scripts/qualify-models.ts`, `scripts/smoke-compose.ts`: optional native qualification.

The [root verification guide](../../docs/development.md) specifies the complete
local/CI commands. Local tests and CI are not a substitute for hosted OAuth,
provider acceptance, backup/restore or workload benchmarks.
