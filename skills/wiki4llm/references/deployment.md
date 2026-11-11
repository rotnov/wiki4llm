# Deployment and topology

Use this reference for installation, upgrades, login-domain changes and recovery.
Paths and commands are relative to the repository root unless stated otherwise.

## Inventory before mutation

Obtain these nonsecret fields from protected records and supported read-only
discovery. Not every field can be reconstructed through the current APIs:

- Backend account ID, Worker name, active version, origin and route configuration.
- Durable Object namespace, class and migration tags; fixed object `authority-v1`.
- Primary Access app ID, exact issuer/audience, policies and IdP IDs.
- Query-secret names, OpenAI project/store IDs and workspace/collection ownership.
- Enabled reader principals, issuer-scoped mappings and publisher grants.
- If present: front account/Worker/version/origin, its Access app/issuer/audience,
  transport identity and secret names, and backend `MCP_FORWARDER` binding.
- MCP clients, callback URIs and separately recorded acceptance results.

Admin `status` lists only workspaces, reader principals and identity mappings;
it does not export publisher grants or the ingestion journal. Keep the complete
latest publisher provisioning JSON and successful write receipts in protected
records. A publisher's successful preview proves access to the requested workspace,
not its full grant set. If those records are missing, stop before modifying an
existing publisher while promising to preserve unknown rights. Obtain the current
configuration or an explicitly approved complete replacement; do not infer grants
from Access policies, visible reader workspaces or a few successful requests.

Credentials stay in the secret manager. Do not commit installation inventories to
this public repository. Account IDs are not passwords, but a deployment-specific
inventory is still operator state rather than a portable recipe.

## Fresh backend

1. Follow `docs/deployment.md` and `gate/docs/deployment.md`. Choose the complete
   workspace topology first: project, collections, repository/branch and empty
   vector stores are immutable ownership bindings after provisioning.
2. Protect the entire backend origin with an Access MCP application and Managed
   OAuth. Set the intended human IdP/policy and separate Service Auth policies for
   publisher and temporary operator. A workers.dev deployment also needs its
   actual hostname covered; do not enable an unprotected preview route.
3. Use the pinned `gate/package-lock.json`, Worker config format and SQLite class
   migration. Keep private deployment configuration under `gate/.data/`.
4. Deploy with `ADMIN_IDENTITIES` set to the JSON string `[]`. Install the query
   secret through protected stdin/environment handling; list existing secret names
   in `secrets.required` for subsequent deploys. Secret installation creates a
   version too: use the correct resulting version for activation.
5. Follow the temporary administrator sequence below. Provision ingestion ownership,
   publisher grant, reader principal and verified identity mapping using the existing
   admin CLI and deployment examples.
6. End temporary administration even if later indexing or client acceptance fails.
   Then run the first index, repeat no-op and real MCP acceptance procedures.

## Temporary administration

Run commands from `gate/`; `GATE_ORIGIN` is the exact **backend** HTTPS origin with
no trailing slash. Inject the temporary pair as `GATE_ACCESS_CLIENT_ID` and
`GATE_ACCESS_CLIENT_SECRET` without exposing values in argv or files.

```sh
npm run admin:worker -- "$GATE_ORIGIN" identity
```

Add only the returned typed service key to `ADMIN_IDENTITIES`. Deploy and explicitly
activate that exact version using the Deployments API's
`code_update_strategy.mode = immediate`, as documented in the gate deployment
recipe. Schedule this outside active ingestion: immediate activation can interrupt
requests. Require successful authenticated `status` before admin mutations.

```sh
npm run admin:worker -- "$GATE_ORIGIN" status --kind principals --limit 20
```

Paginate using `next` as `--after`; one page is not a complete inventory. After the
operation, set `ADMIN_IDENTITIES` back to `[]`, deploy and immediately activate the
exact new version. Remove only the temporary operator policy/token. Read back the
empty allowlist and removal; confirm publisher and reader paths still work.
If cleanup fails, report it as unfinished work, not a successful closed session.

## Separate reader account or branded login

The Access team domain is shared by an account. Do not rename it to rebrand one
application if that would change other applications. The implemented alternative
is the reader front in `gate/src/cloudflare/front.ts`:

1. Keep the backend and its DO, primary issuer/audience, grants and ingestion state.
2. Create the separately authorized account/team and its Access MCP app. Use the
   requested IdP, such as email one-time PIN; this does not require Google OAuth.
3. Create a dedicated backend transport service token/policy. Give its identity
   **no** gate reader, publisher or administrator grant.
4. Deploy the front with `PUBLIC_ORIGIN`, `BACKEND_ORIGIN`, and protected
   `BRIDGE_CLIENT_ID` / `BRIDGE_CLIENT_SECRET` secrets. It has no new authority DO.
5. Set backend `MCP_FORWARDER` to the exact transport identity and new reader
   issuer/audience. Preserve the persisted primary issuer/audience and query secrets.
6. Authenticate to the new `/identity`; bind its returned issuer and key to the
   intended principal through temporary **backend** administration. Inventory the
   new realm with `status --kind identities --issuer "$READER_ISSUER"`.
7. Test the new front, then update clients. Publishers retain the backend origin.
   Verify unrelated account apps/policies unchanged and revoke temporary operator
   access. Keep old reader connectivity until the replacement is accepted.

Use `gate/docs/cloudflare.md` and the front/forwarding tests for the exact binding
contract. Do not rewrite the forwarding headers or bypass either JWT validation.
MCP routes reject browser Origin and MCP session headers; test retrieval with
a compatible stateless MCP client. Only invitation activation accepts the exact
same-origin browser POST; see [invitations](invitations.md) for deployment prerequisites.

## Upgrades and rollback

Run the checks appropriate to changed code in `docs/development.md` before rollout.
Capture the current version and nonsecret binding inventory. Deploy the reviewed
source with existing namespace/migrations and explicit inherited secrets; read
back the active version and bindings. Complete client and publication checks.

Rollback may reactivate a verified prior Worker version, but that does not undo
DO grants, journal writes or OpenAI uploads. Do not reactivate a version missing a
required secret or re-enable a revoked administrator. Restore the matching access
configuration deliberately if rolling back a reader front.

The status API is not a journal backup. A DO point-in-time restore can resurrect
old grants and publication history; reconcile current revocations and provider
resources before reopening traffic. Never delete the namespace or journal as a
routine repair for an indexing or authentication error.
