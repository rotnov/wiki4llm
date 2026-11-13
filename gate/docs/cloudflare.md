# Cloudflare runtime

The optional Worker target serves the same five read-only MCP tools from published
OpenAI Retrieval manifests. One private SQLite Durable Object owns all grants,
identity mappings and publications. The existing Node target still supports QMD,
OpenAI and `qg_` tokens. The Worker accepts only cryptographically verified
Cloudflare Access application assertions; a Node token cannot authenticate it.

## Local verification

```sh
npm ci
npm test
npm run check
npm run build
npm run check:worker
npm run test:worker
npm run check:bundle
npm run dry-run:worker
npm run format:check
```

`test:worker` starts real workerd through the pinned Miniflare package. It generates
RSA keys in memory and intercepts outbound JWKS/OpenAI requests with synthetic
public fixtures. It does not read a credential store or contact a cloud account.
There is no production authentication bypass, test-mode binding or configurable
provider/JWKS origin. The ingestion suite also reopens persisted DO SQLite and
injects a receipt failure to verify rollback after gate chunk writes. `check:bundle` writes ignored output and a dependency
metafile; it rejects native QMD, filesystem, Node HTTP and SQLite dependencies.
Supported Node compatibility crypto/buffer APIs remain in the Worker bundle.

Tooling is pinned to Wrangler 4.116.0 / Miniflare 4.20260730.0 /
workerd 1.20260730.1, with compatibility date 2026-07-30. The newer evaluated
Miniflare 5 beta and this stable package publish defective generated declaration
imports. `scripts/repair-miniflare-types.ts` repairs the stable package's exact
reviewed declaration hash after installation: aliases resolve to the package's
existing complete declarations, malformed generated enum/symbol/MockAgent types
are corrected to their runtime contracts, and Zod 3 types use the public `zod/v3`
compatibility export of the already pinned Zod 4 package. The source-map return
uses its real module namespace. Unknown versions/hashes fail closed. No type
check, test input, or validation rule is excluded. `npm run repair:tooling` is
idempotent; its regression test verifies unknown-input rejection. The dependency
patch changes declaration text only; it does not alter Miniflare runtime code.
Dev-tool dependencies pin compatible patched sharp/undici/esbuild versions;
Puppeteer supplies the omitted published `Process` declaration dependency.

The default configuration is illustrative and has no account IDs or routes.
`workers_dev` and preview URLs are disabled. Dry-run bundles locally; it does not
create a Durable Object namespace, deploy a Worker or configure Access. Local
workerd tests establish runtime behavior, not hosted OAuth acceptance or a
production traffic/memory benchmark.

## Hosted prerequisites and acceptance

Deployment requires separate authorization and operator configuration:

1. Select one HTTPS public origin, Access team issuer and application audience.
2. Protect the entire origin with an Access **MCP Server** application and enable
   **Managed OAuth**. Configure the human identity policy and Service Auth policy
   for automation. Protect `/admin/*`, `/ingest/*` and `/identity` as well as `/mcp`.
3. Configure the Worker variables in `wrangler.jsonc`, the SQLite class migration,
   and project-scoped OpenAI query secrets under the manifest binding's named
   credential variables. Do not use an OpenAI admin credential. For redeployments,
   list each existing query credential name in the deployment configuration's
   `secrets.required` array. The pinned Wrangler then emits explicit inherited
   secret bindings; verify their names after deployment without reading or
   exporting their values.
4. Begin with `ADMIN_IDENTITIES` equal to `[]`. An authenticated operator calls
   `/identity` to read only their own `{issuer,key}`, then an authorized deployment
   operator adds that exact typed key to the configuration allowlist.
5. Bootstrap reader principals/mappings. For CLI/GHA-managed ingestion, provision
   ownership and publisher grants as described in [deployment](deployment.md),
   then let the CLI publish. Manual manifest import is a separate mode for
   workspaces that are not ingestion-managed; do not combine these modes.
6. With a real MCP client, verify Access discovery, authorization, token exchange,
   refresh, logout/expiry, unauthenticated challenges and the five MCP tools.
   Test a restricted identity and an independently mapped service identity.

An uploaded version is not sufficient evidence that an active Durable Object has
adopted its new operator configuration. Cloudflare's default rollout can defer
that transition. For operator bootstrap and revocation, explicitly activate the
uploaded version through the Worker Deployments API with
`code_update_strategy: { "mode": "immediate" }`, keeping that exact version at
100 percent traffic. This works with the pinned upload tooling and avoids relying
on a newer Wrangler flag. Immediate activation can interrupt in-flight requests;
perform it outside ingestion attempts. Before administrative writes, verify the
expected service identity at `/identity` and successful authenticated access to
`/admin/status`. After revocation, verify the empty admin allowlist and removal of
temporary Access policies/tokens. The rollout behavior is described in
[Cloudflare's deferred-update announcement](https://developers.cloudflare.com/changelog/post/2026-10-30-durable-objects-deferred-code-updates/).

Cloudflare Access serves OAuth discovery and handles token exchange/refresh; it
converts unauthenticated requests to the OAuth challenge. The origin does not
implement another authorization server, forward opaque OAuth tokens, or invent
OAuth metadata. Only `Cf-Access-Jwt-Assertion` is trusted after RS256 validation.
These edge prerequisites and the real client handshake have not been exercised
by local tests.

Primary contracts: [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/),
[application assertions](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/),
[JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/),
[SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

## Identity and authority

Human keys are `user:{sub}`. Application service-token assertions must have empty
`sub` and a valid `common_name` client ID ending in `.access`; their keys are
`service:{common_name}`. Email, cookies, forwarding headers, custom groups,
caller-selected object IDs and internal-looking identity headers confer no
permissions. Assertions require exact issuer/audience, `type=app`, RS256, integer
`iat`/`exp` and valid `nbf` when present. Expiry is checked again before release.

The fixed object is named `authority-v1`. Its database permanently binds the exact
issuer and audience at first initialization. Changing either while reusing the
state fails closed with 503. Changing authority requires a deliberately new
instance/namespace and explicit bootstrap/import. Never change an audience to
silently reuse grants. The outer Worker validates Access, forwards the request
stream to that fixed private object, and the object independently validates the
assertion; caller headers cannot forge a trusted internal identity envelope.

An explicit identity mapping points at an existing enabled principal. Grants use
the existing allow/deny patterns, with deny precedence and future-workspace
matching. Unknown/disabled/unbound identities have no corpus access. Reads
recheck mapping, principal, grants, expiry and selected publication generations
before release, including when an admin modifies state during provider I/O.

Administration is separately controlled by the configuration-only allowlist
`ADMIN_IDENTITIES` (JSON array, at most 32 exact typed keys, same fixed issuer).
Read-all grants never imply administration. Administrators also need a mapped
principal to read documents. No MCP management tools are exposed.

## Operator API and client

All requests need Access authentication. JSON schemas reject unknown fields.
Successful responses include no document bodies, raw manifests or credentials.

| Route              | Method | Input                                                |
| ------------------ | ------ | ---------------------------------------------------- |
| `/identity`        | GET    | None; returns only the caller's issuer and typed key |
| `/admin/principal` | POST   | `id`, `grants: {allow, deny}`, `enabled`             |
| `/admin/identity`  | POST   | `key`, `principal`, `enabled`                        |
| `/admin/unbind`    | POST   | `key`                                                |
| `/admin/import`    | POST   | `id`, `binding`, `manifestText`                      |
| `/admin/status`    | GET    | Optional `kind`, `after`, `limit` query parameters   |

Inventory responses are also capped at 64 KiB; a page may contain fewer than
`limit` items to fit that bound.

Status `kind` is `workspaces`, `principals` or `identities`; the default is
`workspaces`. `limit` is 1–20. Pass returned `next` as `after` to continue.
Workspace inventory returns metadata and chunk sizes, never snapshot bodies.
Publisher grants and ingestion journals are not available through this inventory.
Publisher updates replace the entire grant set. Preserve the latest provisioning
input and successful write receipt in protected operator records; a publisher
preview tests one workspace's authorization and cannot reconstruct all its grants.

For a hosted Access-protected origin, the operator client uses
`GATE_ACCESS_CLIENT_ID` and `GATE_ACCESS_CLIENT_SECRET` from its process
environment. Access authenticates these Service Auth headers and supplies the
signed origin assertion. Ordinary human MCP clients use Managed OAuth.

`GATE_ACCESS_ASSERTION` is an alternative only for a controlled origin or local
test path that already has a verified Access assertion available. Sending that
header is not a claim that the Access edge accepts it as client authentication;
it does not implement a browser login or OAuth flow.

Supply values through an approved secret environment; do not put them in shell
arguments, JSON input, tracked files or terminal output. The client sends them
only to the explicitly configured HTTPS origin, refuses redirects, bounds
responses and sanitizes failures. The `status` command accepts explicit
`--kind`, `--after` and `--limit` flags. Pass the previous response's `next` value
as `--after`; omit it for the first page and stop when `next` is null. The exported
`adminRequest` function accepts the corresponding `{kind, after, limit}` object
as its third argument for `status`. All controls are validated before a request.

```sh
npm run admin:worker -- https://gate.example.com identity
npm run admin:worker -- https://gate.example.com principal principal.json
npm run admin:worker -- https://gate.example.com bind identity.json
npm run admin:worker -- https://gate.example.com import publication.json
npm run admin:worker -- https://gate.example.com status --kind principals --limit 10
npm run admin:worker -- https://gate.example.com status --kind identities --after service:previous-client.access --limit 10
npm run admin:worker -- https://gate.example.com unbind unbind.json
```

Example principal input:

```json
{
  "id": "reader",
  "grants": { "allow": ["team-*"], "deny": ["team-private"] },
  "enabled": true
}
```

Example identity input:

```json
{ "key": "user:verified-subject-id", "principal": "reader", "enabled": true }
```

Import input contains an unchanged producer manifest encoded as the `manifestText`
string, plus an explicit workspace binding:

```json
{
  "id": "team-guide",
  "binding": {
    "projectId": "proj_example",
    "credentialEnv": "PROJECT_QUERY_KEY",
    "stores": { "guide": "vs_example" }
  },
  "manifestText": "{producer manifest JSON, encoded as a JSON string}"
}
```

The last example documents the wrapper shape, not a valid producer manifest.
Using a string preserves duplicate-key rejection. An existing workspace's project,
credential variable and collection/store map are immutable. Exact reimports are
no-ops; generation rollback, same-generation changes and reused publication IDs
fail atomically. The Node and Durable Object stores share that policy.

## Resource bounds and recovery

- Access: 16 KiB assertion, 24 KiB total request header characters; one JWKS fetch
  at a time per verifier, eight active validations, 64 KiB JWKS, at most 32 RSA
  keys, three-second deadline, five-minute cache and 30-second refresh cooldown.
- MCP: 128 KiB streamed input; one active request and sixteen queued requests,
  admitted before body parsing/SDK creation. Queue deadline is 120 seconds; body
  deadline is 15 seconds. Saturation returns 429 with `Retry-After: 1`.
- Imports: one admitted streamed body, 17 MiB wrapper, 8 MiB manifest, 20
  collections and 10,000 files. Other imports receive 429 before body reading.
  Four independent small operator bodies may run concurrently, each capped at
  128 KiB and a 30-second body deadline. Revocation remains available during
  provider I/O. Cancellation releases admission permits in `finally`.
- Workspace selection and gateway maps retain only metadata. A private lazy
  resolver loads one snapshot for each sequential provider operation, checks its
  requested generation and does not cache snapshots across requests. Twenty
  selectors do not retain twenty snapshots. One active provider snapshot may
  coexist with one admitted manifest import.
- SQLite snapshot parts are at most 900 KiB of encoded bytes. Atomic metadata,
  digest, part count and ordered chunks detect incomplete/corrupt storage;
  UTF-8 is decoded only after byte reassembly. All SQL values are bound parameters.
- Gateway logical output limits (64 KiB query/discovery/status; 4 MiB reads),
  2 MiB provider responses and provider timeouts
  remain. Parsed-content pagination fails closed. Search still considers only
  the first 50 chunks per collection and is explicitly incomplete.

Keep reviewed producer manifests and operator policy inputs in their existing
systems of record; the status API is not an export of full snapshots. Recovery
requires those inputs plus separately managed secrets. Restore policy explicitly,
then import publications; never infer principal grants from the document corpus.
Cloudflare SQLite Durable Objects support point-in-time recovery, but an actual
account backup/restore drill is a deployment acceptance step, not a local-test
claim. Restoring to an older state also restores its grants and publication
history; reconcile current revocations and generations before reopening traffic.
For authority migration, provision a fresh named object/namespace, bootstrap
under the new issuer/audience, import, verify isolation, then switch the origin
only through an authorized deployment process.

## Durable ingestion from ephemeral runners

The separate publisher API stores a provisioned producer journal in the same DO
as the gate publication. An administrator assigns service-identity publisher masks
and immutable project/collection/repository/store ownership. Publishers acquire a
120-second fenced lease and submit bounded operation deltas with revision CAS and
idempotency receipts. Active publication and gate chunks commit atomically; MCP
readers continue seeing the prior publication during staging.

See [ingestion protocol v1](ingestion-state-protocol.md) for exact routes, schemas,
phase transitions, lease-free preview chunks, limits and reconciliation duties.
This is a fresh-index protocol; it cannot adopt a legacy local journal or manual
publication. Retired ownership is retained, with a 100,000-record maintenance
limit. It does not guarantee exactly-once OpenAI calls or activate a GitHub Actions
workflow. Publisher grants are separate from reader mappings and admin privilege;
human MCP OAuth remains read-only.

## Separate-account reader entrypoint

An optional Access-protected front Worker (`src/cloudflare/front.ts`) provides a
new MCP login domain without moving the backend Durable Object or ingestion
journal. Deploy it on the new account's own Workers hostname. Its `PUBLIC_ORIGIN`
is that HTTPS origin; `BACKEND_ORIGIN` is the existing protected backend origin.
`BRIDGE_CLIENT_ID` and `BRIDGE_CLIENT_SECRET` are Worker secrets for a dedicated
backend-account Access service token. This transport identity must have no gate
principal, publisher grant or administrative privilege.

On the backend, optional `MCP_FORWARDER` is a JSON deployment binding containing
`identity` (the exact typed transport service identity), `issuer` (the new Access
team issuer) and `audience` (the new MCP application's audience). These are
nonsecret identifiers. The backend independently validates both the original
transport assertion and the separately forwarded signed user assertion. The
user must be human and both assertions must remain valid. Reader routes are
`/mcp`, read-only `/identity`, and the authenticated `/invite/{token}` browser
flow. A transport credential alone cannot access these surfaces. Existing direct authentication and publisher endpoints remain
unchanged; forwarded requests cannot administer or ingest.

Map the verified new identity explicitly with `/admin/identity`, adding its
`issuer` to the usual `key`, `principal` and `enabled` fields. Never infer the new
subject from an email header or assume subjects match across accounts. Identity
lookups use issuer plus key; equal subjects from different accounts remain
distinct. The optional issuer must be the primary or configured reader issuer.
`/admin/unbind` accepts the same optional issuer. Identity inventory defaults to
the primary issuer; select the reader realm with
`status --kind identities --issuer https://reader.cloudflareaccess.com`.
Pagination remains scoped to that issuer. Principal grants, manifests, store
reservations and ingestion ownership are shared unchanged; the persisted primary
issuer/audience guard is not migrated or relaxed.

The front forwards `/mcp` POST, `/identity` GET, and invitation GET/POST to the fixed backend,
without following redirects. It strips client credentials/cookies, injects the
transport credentials, and forwards the signed edge assertion in
`X-Wiki-Rag-Reader-Assertion`. Backend cookies and credential headers never reach
the client. Protect the front hostname with a Managed OAuth Access application
and configure its identity policy independently. The two public MCP endpoints
can coexist while clients move; GHA publishers retain the backend origin.

### Transport credential rotation

The backend accepts exactly one `MCP_FORWARDER.identity`; the front and backend
cannot be switched atomically. The current implementation does not provide
zero-downtime transport rotation. Agree on a brief reader interruption and perform
immediate backend activation outside active ingestion attempts.

1. Record current backend/front versions and nonsecret bindings. Retain the old
   secret in the approved secret manager while it remains trusted; never export it
   into the inventory. Create the replacement service token and a dedicated Service
   Auth policy without removing the old policy. Give neither token any gate grant.
2. Call the backend `/identity` with the new token to verify its exact typed key.
   Prepare the front's replacement secrets and backend forwarder configuration.
   Installing Worker secrets can create/activate versions, so perform the actual
   front secret writes during the maintenance window, not as a harmless preflight.
3. Switch backend `MCP_FORWARDER.identity` to the new key; deploy and immediately
   activate the exact version. Preserve reader issuer/audience, the primary
   authority binding and all query-secret names. The old front may now fail closed.
4. Install the matching new `BRIDGE_CLIENT_ID` and `BRIDGE_CLIENT_SECRET` on the
   front, deploy/activate the intended version with both required secret bindings,
   and read back both Workers' active versions and nonsecret settings.
5. Verify human OAuth through the front with `/identity` and real MCP query/get,
   plus the intended denied-access case. Confirm the backend publisher still works.
   Only after acceptance, revoke the old transport token and its dedicated policy.
6. If the switch fails, restore the matching old front/backend configuration only
   while the old credential remains trusted and valid. Do not restore revoked or
   compromised credentials; keep access closed and repair the new configuration.

Preserve unrelated policies and the permanent publisher throughout. A requirement
for uninterrupted readers needs a separately designed overlap mechanism rather
than claiming this sequence is seamless.

## Reader invitation links

See [email-bound invitation links](invitations.md) for create/status/revoke commands,
browser authentication prerequisites, reader-front configuration and acceptance checks.
