# Deploy the Cloudflare gate

This recipe deploys the OpenAI-backed Worker and SQLite Durable Object. Start with
[the stack guide](../../docs/deployment.md) for OpenAI resources and ingestion.
Run the commands below from `gate/`. No tunnel or dedicated server is needed for
this target; native Node/QMD hosting is a separate [Compose deployment](containers.md).

## Prepare Access and operator credentials

Choose a hostname in a Cloudflare-managed zone, such as `gate.example.com`.
Configure an Access MCP server application protecting the **entire hostname**,
including `/identity`, `/admin/*` and `/ingest/*`, not only `/mcp`.

Enable [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/).
The Worker validates the Access JWT, so it is compatible with this mode. Configure
the chosen MCP clients' allowed redirect URIs and dynamic client registration as
needed. Restrict the human Allow policy to intended users or groups.

Create two Access service tokens and specific Service Auth policies:

| Identity           | Purpose                                             | Lifetime                |
| ------------------ | --------------------------------------------------- | ----------------------- |
| Temporary operator | Bootstrap grants and workspace bindings             | Revoke after setup      |
| Publisher          | CLI/GHA ingestion for explicitly granted workspaces | Managed rotation/expiry |

Keep the operator policy separate so removing it cannot remove the publisher's
access. Capture each client ID and secret in your secret manager. Do not put values
in Git, terminal arguments or JSON provisioning files. Access authentication alone
does not give either identity reader, publisher or administrator permissions.

Record the Access application audience and exact team issuer. The DO binds them
permanently at first use. Do not recreate the app or change issuer/audience while
reusing the namespace; that is an explicit migration, not routine configuration.

Provide a scoped `CLOUDFLARE_API_TOKEN` to the operator process. It must authorize
the intended Worker/DO deployment, hostname setup and Access administration.
Cloudflare credentials are not passed to ingestion jobs or MCP clients.

## Install and configure

```sh
npm ci
npm run check:worker
npm run check:bundle
mkdir -p .data/deploy
```

Create `.data/deploy/wrangler.json`, replacing the account, hostname, issuer and
audience below. Keep the existing Worker name and namespace when upgrading an
already deployed installation. Paths are relative to this configuration file.

```json
{
  "name": "wiki-rag-gate",
  "account_id": "YOUR_CLOUDFLARE_ACCOUNT_ID",
  "main": "../../src/cloudflare/worker.ts",
  "compatibility_date": "2026-07-30",
  "compatibility_flags": ["nodejs_compat"],
  "workers_dev": false,
  "preview_urls": false,
  "vars": {
    "PUBLIC_ORIGIN": "https://gate.example.com",
    "ACCESS_ISSUER": "https://example.cloudflareaccess.com",
    "ACCESS_AUDIENCE": "YOUR_ACCESS_APPLICATION_AUDIENCE",
    "ADMIN_IDENTITIES": "[]"
  },
  "durable_objects": {
    "bindings": [{ "name": "GATE", "class_name": "GateDurableObject" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["GateDurableObject"] }],
  "routes": [{ "pattern": "gate.example.com", "custom_domain": true }]
}
```

This matches the pinned Wrangler/toolchain and migration format. Do not replace
the migration or create another namespace during a source-repository rename.

```sh
npx wrangler deploy --config .data/deploy/wrangler.json --strict
npx wrangler secret put OPENAI_QUERY_KEY --config .data/deploy/wrangler.json
```

The second command prompts for the **project query key**, not an organization
admin or ingestion key. Supply it through the hidden prompt or approved stdin
secret injection. It creates a new Worker version. See
[Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

After installing the secret, add this top-level property to the deployment config:

```json
{ "secrets": { "required": ["OPENAI_QUERY_KEY"] } }
```

The pinned deploy path explicitly inherits required existing secrets. Do not add
this requirement before the first secret exists. Later project query secrets must
also be listed. Preserve their names and check bindings after each deployment.

Verify an unauthenticated `/mcp` request receives an Access OAuth challenge:

```sh
curl -i https://gate.example.com/mcp
```

Expect 401 plus `WWW-Authenticate` OAuth metadata, not a successful MCP response.
This verifies the edge challenge, not reader access or provider retrieval.

## Bootstrap the temporary operator

Export nonsecret `GATE_ORIGIN` with the same exact origin as `PUBLIC_ORIGIN`. Inject
the temporary operator pair as `GATE_ACCESS_CLIENT_ID` and
`GATE_ACCESS_CLIENT_SECRET`, then inspect its verified identity:

```sh
npm run admin:worker -- "$GATE_ORIGIN" identity
```

It returns `{issuer,key}`. Add that exact typed `service:...access` key to the
deployment config's JSON-string allowlist, for example:

```json
{ "ADMIN_IDENTITIES": "[\"service:operator-client-id.access\"]" }
```

Redeploy, then apply the exact uploaded version immediately using the next section.
Only after authenticated `status` succeeds should you issue administrative writes:

```sh
npx wrangler deploy --config .data/deploy/wrangler.json --strict
# Activate the returned version immediately, as described below.
npm run admin:worker -- "$GATE_ORIGIN" status
```

An empty workspace list is normal before the first publication. A successful
`identity` call alone does not establish administrator readiness.

## Apply operator configuration immediately

Cloudflare may keep an active DO on its previous deployment temporarily.
An upload receipt alone does not prove that a new administrator allowlist is active.
For bootstrap and revocation, use the supported Deployments API with
`code_update_strategy.mode = immediate`. This can interrupt in-flight requests;
pause ingestion and do it outside active ingestion attempts.

Export nonsecret `GATE_VERSION_ID` with the exact UUID returned by the deploy command.
If a later secret operation created another version, use that intended latest
version instead. Do not accidentally reactivate an older version without its
new secret. The Cloudflare token stays in the environment:

```sh
uv run --project .. python - <<'PY'
import json
import os
from pathlib import Path
import httpx

config = json.loads(Path(".data/deploy/wrangler.json").read_text())
url = (
    "https://api.cloudflare.com/client/v4/accounts/"
    + config["account_id"] + "/workers/scripts/" + config["name"] + "/deployments"
)
body = {
    "strategy": "percentage",
    "versions": [{"version_id": os.environ["GATE_VERSION_ID"], "percentage": 100}],
    "code_update_strategy": {"mode": "immediate"},
}
with httpx.Client(timeout=45, follow_redirects=False, trust_env=False) as client:
    response = client.post(
        url,
        headers={"Authorization": "Bearer " + os.environ["CLOUDFLARE_API_TOKEN"]},
        json=body,
    )
    response.raise_for_status()
    result = response.json()
    if not result.get("success"):
        raise SystemExit("Deployment activation failed; inspect the account before retrying")
    print(result["result"]["id"])
PY
```

Check the deployed version, unchanged namespace and secret bindings in Cloudflare.
For bootstrap, repeat `identity` and `status` with the same operator credentials.
A 403 before immediate activation followed by 200 afterward means the new
configuration was not yet usable at the earlier check. Do not grant a broader role
to work around that condition. [Cloudflare rollout reference](https://developers.cloudflare.com/changelog/post/2026-10-30-durable-objects-deferred-code-updates/).

## Provision one workspace and its identities

```sh
cp ../examples/deployment/ingestion.json .data/deploy/
cp ../examples/deployment/publisher.json .data/deploy/
cp ../examples/deployment/reader.json .data/deploy/
cp ../examples/deployment/identity.json .data/deploy/
```

Edit these nonsecret files before applying them. Use the actual project and fresh
store IDs, all intended collection bindings, and the named query-secret variable.
The producer TOML must match. Discover the publisher's typed identity using its own
service-token pair and `identity`; then restore the operator pair for admin calls.
For a human reader, visit `/identity` after authenticating through Access and use
the returned `user:{sub}`. Do not substitute an email or unrelated account ID.

```sh
npm run admin:worker -- "$GATE_ORIGIN" ingestion .data/deploy/ingestion.json
npm run admin:worker -- "$GATE_ORIGIN" publisher .data/deploy/publisher.json
npm run admin:worker -- "$GATE_ORIGIN" principal .data/deploy/reader.json
npm run admin:worker -- "$GATE_ORIGIN" bind .data/deploy/identity.json
```

Successful writes return `{"ok":true}`. Reader grants, publisher grants and
administrator privilege are independent. Keep the publisher limited to its
intended workspace or reviewed prefix masks. Provisioning does not upload files
or create a visible MCP publication; the first successful CLI index does that.
Do not use manual `import` for an ingestion-managed workspace.

Exact schemas, idempotency and immutable ownership rules are owned by the
[ingestion protocol](ingestion-state-protocol.md), while the general admin/reader
contract is in [Cloudflare runtime](cloudflare.md).

## End operator access and verify service operation

1. Set `ADMIN_IDENTITIES` back to the JSON string `[]`, redeploy and activate that
   exact version immediately. Keep the issuer, audience, namespace and required
   query-secret names unchanged.
2. Remove only the temporary operator policy/token. Preserve the publisher's
   policy/token for CLI/GHA; its separate publisher grant remains enabled.
3. Read back Cloudflare settings and confirm the empty admin allowlist and deleted
   temporary resources. Preserve IDs/receipts without secret values. If setup fails,
   perform this cleanup before ending the operator session too.
4. Run publisher `status`/`plan`, apply an initial index, and verify real OAuth MCP
   query/get as described in the [stack guide](../../docs/deployment.md).

For later administration, create a fresh temporary operator identity and repeat
the explicit allowlist/activation/readiness sequence. Normal human OAuth never
becomes an administrator merely because it can read all workspaces.

## Operations

Use the same config and Worker/DO identity for ordinary upgrades. Deployments
preserve DO state when those identities stay the same; source-code rollback does
not roll back its journal or provider files. Rotate query credentials by installing
the replacement, activating its version, testing retrieval, then revoking the old
key. Rotate publisher tokens with their corresponding Access policy and gate grant.

Keep a recovery inventory of project/store IDs, bindings, principals, identity and
publisher grants, and deployed versions in the operator's protected system of
record. The status API lists workspaces, reader principals and identities; it does
not export publisher grants or the journal. Preserve complete publisher provisioning
inputs and write receipts; do not reconstruct unknown grants from reader inventory
or individual successful requests. A DO
restore also restores past grants and publication state, so reconcile revocations
and provider resources before reopening traffic. No automatic backup/restore or
workspace-topology migration is supplied by this recipe.
