# Access and client connections

Use this reference for grants, revocation, OAuth and client onboarding. Read
`gate/docs/cloudflare.md` and `gate/scripts/cloudflare-admin.ts` for the current
contract before issuing mutations. Commands below run from `gate/`, with an active
temporary administrator and backend `GATE_ORIGIN` already established.

## Reader grants and identity mappings

1. Inventory the intended principal and identity realm. Preserve existing grants
   unless the user requested their removal; principal updates replace the supplied
   grant set, not an incremental patch.
2. Authenticate the intended reader and read `/identity`. Use that exact
   `{issuer,key}`. Human keys are `user:{sub}`; service keys are
   `service:{common_name}`. Email is an Access-policy selector, not a gate key.
3. Prepare a principal and mapping as private JSON files, using the examples in
   `examples/deployment/`. Apply principal first, then bind, and read back inventory.

```sh
npm run admin:worker -- "$GATE_ORIGIN" principal .data/deploy/reader.json
npm run admin:worker -- "$GATE_ORIGIN" bind .data/deploy/identity.json
npm run admin:worker -- "$GATE_ORIGIN" status --kind principals --limit 20
npm run admin:worker -- "$GATE_ORIGIN" status --kind identities --limit 20
```

For a reader from the separate account, include `issuer` explicitly in the mapping
and use `--issuer` with identity inventory. Unbinding that mapping also needs its
issuer. Omitting it addresses the primary realm, not every matching subject.

Grant grammar is owned by `gate/src/policy.ts`: exact workspace slug, `prefix-*`,
or `*`. Deny wins. `team-*` covers `team-mobile` and future matching workspaces but
does not cover `team` itself. It is not an arbitrary regex or shell glob.

Use an exact workspace grant for a narrowly scoped agent; use prefix/future access
only when requested. A query's workspace filter narrows a credential's access and
cannot expand it. Do not grant `*` merely to debug an empty result.

Verify list/status and a known query/get, then an out-of-scope workspace and document
reference using a restricted identity. Unknown or disabled identities must not
receive corpus content. A principal with read-all grants still cannot administer.

## Publisher and administrator permissions

Publishers require both an Access Service Auth policy and an enabled gate publisher
grant. Use the publisher's own credentials with `identity` to discover its typed
key, then switch back to the temporary operator credentials for provisioning:

```sh
npm run admin:worker -- "$GATE_ORIGIN" ingestion .data/deploy/ingestion.json
npm run admin:worker -- "$GATE_ORIGIN" publisher .data/deploy/publisher.json
```

The ingestion request fixes the complete workspace ownership. Publisher masks
authorize writes to that workspace; they do not grant reader or admin access.
Never send the temporary operator pair or Cloudflare management token to GHA.

Publisher writes replace the entire grant set; they do not append permissions.
There is no publisher inventory/readback endpoint in the current admin API.
Before modifying an existing publisher, obtain its complete current provisioning
JSON from protected records, preserve intended grants, then save the new JSON and
write receipt. Verify allowed and denied workspace access with publisher previews.
These checks are behavioral evidence, not an export of all grants. If the prior
configuration is unavailable, do not guess: obtain it or an explicit decision to
replace the complete grant set.

For revocation, choose the intended scope: disable a reader mapping, disable its
principal (affects every mapped identity), unbind an exact issuer/key, or disable
a publisher grant. Inspect the affected identities before changing a shared
principal. Revoke the relevant Access credential/session as well when requested;
gate grant removal does not itself erase the client's OAuth credential.
Read back reader changes where inventory is supported and verify denial with the
affected credential. For publisher changes, retain the write receipt and perform
the behavioral checks above; do not claim a publisher configuration readback.

Transport rotation is not atomic: the backend accepts one forwarder identity and
the two Workers deploy independently. Use the maintenance-window sequence in
`gate/docs/cloudflare.md` under "Transport credential rotation". Establish the
allowed interruption before switching; do not promise zero downtime or add the
transport identity to a reader principal as a shortcut.

## Managed OAuth settings

Read the current Cloudflare Managed OAuth documentation and existing app settings
before editing. Preserve other IdPs, applications and callbacks. Configure an
email-code policy only on the requested application; do not change a shared Google
IdP to solve an unrelated login problem.

`oauth_configuration.dynamic_client_registration.allowed_uris` contains exact
client redirects. Discover each callback from the actual client; ChatGPT can use
a connector-specific callback, so do not hardcode one from another installation.
Loopback/localhost registration is a separate setting for local clients.

`session_duration` on the Access app is the browser session. Under OAuth `grant`,
`access_token_lifetime` is the access-token clock and `session_duration` is the
grant/refresh-session clock. Follow the user's duration decision, verify provider
limits live, write only the intended fields, and read back the result. A successful
value readback is not a refresh/expiry test. Do not encode one account's maximum
as a universal default. Refresh requests do not consume model inference tokens.

## Connect and verify clients independently

Start with an unauthenticated MCP POST and inspect its `401` challenge. Fetch the
exact `resource_metadata` URL from `WWW-Authenticate`, then the advertised issuer
metadata. Verify resource, authorization/token endpoints and registration method.
Use real client OAuth; do not manually forward a browser cookie or JWT as a fix.

| Client               | Setup and acceptance                                                                                                                                                             |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex Desktop / CLI  | Add Streamable HTTP URL and complete `codex mcp login`; confirm the active host configuration and execute tools.                                                                 |
| Claude web / Desktop | Add a remote **Web Custom** connector, complete OAuth, verify Connected and tools. A local Desktop extension is not equivalent.                                                  |
| ChatGPT web          | Plugins, Add custom MCP server, HTTPS `/mcp`, OAuth/DCR, Create as a plugin, then Connect. Inspect Connected accounts and Refresh tools.                                         |
| Codex Cloud          | Check the current supported plugin path and a runnable published environment. Test in that cloud environment; local TOML and ChatGPT connection alone are insufficient evidence. |

ChatGPT's advanced OAuth form shows discovered endpoints and the actual callback
under its client configuration. If creation reports rejected settings, compare
the callback against the Access allowlist. If it later shows a network error,
inspect installed plugins before retrying: creation may have succeeded while the
next connection step failed. Resume **Connect** on the existing plugin.

Cloud acceptance progresses through saved configuration, OAuth, five discovered
tools, and actual authorized retrieval. Keep each result separate. The tools are
`list_workspaces`, `status`, `query`, `get`, `multi_get`; there are no MCP admin tools.
If a cloud environment is Unpublished, report the missing runtime test and obtain
the intended environment before publishing or launching a new cloud chat.

Current primary references to recheck when UI or behavior changes:

- [Cloudflare Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
- [OpenAI custom MCP setup](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp)
- [Codex cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environments)
- [Claude remote versus Desktop connectors](https://support.claude.com/en/articles/11725091-when-to-use-desktop-and-web-connectors)
