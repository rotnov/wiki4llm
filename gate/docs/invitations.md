# Email-bound invitation links

An administrator creates a one-time link for an email and workspace slugs or namespace
patterns such as `amplifier-*`. The recipient opens it, authenticates through Cloudflare
Access, and receives reader permissions on their issuer-scoped identity. The
success page shows the authenticated email and a list of effective workspaces.
The creation result supplies an English MCP prompt for the administrator to
forward to the teammate as one block containing the invitation link. No separate acceptance
button is needed. Creating an invitation does not send mail.

## Operator commands

Use the existing backend administrator credentials and run from `gate/`.
Store input files in ignored `gate/.data/`; never commit real recipients or links.

Create `invite.json` with this shape:

```json
{
  "email": "person@example.org",
  "workspaces": ["example"],
  "expiresInSeconds": 604800
}
```

```sh
npm run admin:worker -- "$GATE_ORIGIN" invite .data/invite.json
```

The result is `{id, url, expiresAt, prompt}`. Share the URL and connection prompt
privately with the intended recipient. The prompt embeds the exact invitation URL
and instructs the recipient to wait for **Access granted** before adding the web
connector through computer use. Do not send only the MCP URL: connector OAuth
login alone does not accept the invitation. The raw token is returned only on creation; the database stores its
SHA-256 hash. Lost links require a new invitation and revocation of the old one.
The default lifetime is seven days; explicit lifetimes range from 60 seconds to
30 days. Exact workspace slugs must already exist. Namespace patterns such as `amplifier-*`
are stored verbatim as allow grants and include future matching workspaces; they
can be issued before the first matching workspace is published. A namespace mask
matches `amplifier-project` but not `amplifier` or `amplifierx-project`. Existing
deny rules still take precedence. Global `*` and arbitrary glob syntax are rejected.
For “all Amplifier workspaces”, use the verified `amplifier-*` namespace rather than
expanding it to today's list. Status returns the stored patterns; the recipient
page shows the currently published workspaces those grants permit.

For status or revocation, put `{"id":"the-returned-uuid"}` in a private JSON file:

```sh
npm run admin:worker -- "$GATE_ORIGIN" invite-status .data/invite-id.json
npm run admin:worker -- "$GATE_ORIGIN" invite-revoke .data/invite-id.json
```

Status returns the email, issuer, workspaces, expiry and state (`pending`,
`accepted`, `revoked`, `expired`), never the token. Revoking an accepted invitation
returns a conflict; revoke the actual identity mapping or principal instead.
Invitation expiry never expires permissions already granted by acceptance.

## Browser and deployment contract

Protect `/invite/*` with Cloudflare Access browser authentication. Its application
assertion must have the issuer and audience configured for the gate (or the
reader-front realm). The recipient must be allowed to authenticate by the Access
policy before opening an invitation; invitation creation does not edit that policy.
The signed application token's `email` is the IdP-verified email according to
[Cloudflare's application token contract](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/).
The gate never uses an email forwarding header. Email matching is case-insensitive;
provider-specific dot or plus aliases are not merged. Missing signed email fails closed.

For a single origin, links and MCP use `PUBLIC_ORIGIN`. With a separate reader
front, deploy both updated Workers and configure backend `READER_ORIGIN` to the
front's exact HTTPS origin, alongside the existing `MCP_FORWARDER`. Invitations
then target the forwarder's issuer. The front forwards only `/mcp`, `/identity`
and `/invite/{token}`; admin routes remain backend-only. The transport identity
cannot accept an invitation or administer the gate. A browser app with a different
Access audience will not work until the topology is explicitly configured; do not
silently weaken audience validation or change authority bindings.

GET displays a generic page without granting access or consuming the link. The
page automatically POSTs to the same URL after authentication. POST requires the
exact browser Origin and a small JSON body. There are no CORS exceptions on MCP
or admin endpoints. Plain email previews and GET-only crawlers cannot consume
invitations; an authenticated browser executing the page JavaScript can.

The page has no external assets, sets `no-store`, `no-referrer`, `nosniff`, and a
nonce-based CSP with framing blocked. Its script renders returned workspace names as text nodes. The page does not
repeat the setup prompt. Keep invitation URL paths out of application/access log exports and
analytics; the page policy cannot control upstream proxy logs or browser history.

Activation is a single SQLite transaction: validate token hash, expiry, email,
issuer and account state; grant rights; bind identity; mark accepted. A second
activation POST returns conflict. Reloading the invitation page after acceptance
reads current grants only for the same authenticated recipient, without granting
anything again. Disabled or unbound identities fail closed; other identities cannot
read the recipient's grants. If a response was lost, an operator can inspect invitation status and
identity permissions; do not repeatedly issue replacement grants blindly.

Existing allow patterns and deny rules are retained. A new private principal is
created for the accepting identity so other users on a shared principal gain no
rights. This snapshots the prior grants: subsequent edits to the old shared
principal no longer affect the moved identity. Disabled mappings or principals
are not re-enabled. The existing combined 100-rule grant limit also applies to merged grants; exceeding
it rolls back activation and leaves the invitation pending. Existing deny rules still win, and the page displays effective
access, not a promise that every requested workspace was allowed. No-access results
show an explanatory message.

## API ownership

- `POST /admin/invitation`: creation payload above; administrator-only.
- `POST /admin/invitation-status`: `{id}`; administrator-only.
- `POST /admin/invitation-revoke`: `{id}`; administrator-only.
- `GET /invite/{64-hex-token}`: authenticated browser page, no mutation; an accepted invitation shows the
  matching recipient's current workspace list.
- `POST /invite/{64-hex-token}`: same-origin authenticated activation; returns
  `{email, workspaces}`. Incorrect identity/expired/revoked tokens return
  403; replay returns 409. Invalid input returns 400.

Implementation: `src/cloudflare/invitations.ts` owns persistence and rendering;
`worker.ts` owns route authentication, origins and dispatch; `front.ts` owns
reader forwarding; `scripts/cloudflare-admin.ts` owns the operator client.
Tests use synthetic JWTs and SQLite/workerd, not live user mail or permissions.
Production rollout, real browser login and MCP-client retrieval remain separate
acceptance steps after deployment authorization.
