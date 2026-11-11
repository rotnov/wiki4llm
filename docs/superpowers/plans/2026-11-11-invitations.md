# wiki4llm invitations implementation plan

> Execute inline with behavior tests before runtime changes.

**Goal:** An administrator creates an email-bound link with exact workspace or namespace grants;
Cloudflare authentication activates it and displays effective workspaces. The
administrator receives the connection prompt to forward with the invitation.

**Architecture:** SQLite Durable Object owns token hashes, expiry, revocation and
atomic identity grants. A protected browser page performs a same-origin POST after
GET. Existing Access authentication remains mandatory, including reader-front realms.

**Constraints:** No deployment or policy changes. Node 24+, existing pinned libraries.
No invitation mail is sent automatically. Links expire after seven days by default.

## Tasks

- [x] Test real Worker creation, browser GET without mutation, activation, email mismatch,
      missing authentication, cross-origin requests, revocation and replay.
- [x] Add signed email extraction, invitation persistence and isolated additive grants.
      Preserve existing denies, disabled identities and principals shared by other users.
- [x] Add authenticated browser routes and reader-front transport, with strict origin
      checks, no-store, no-referrer and a restrictive CSP. Show actual granted workspaces.
- [x] Add operator create/status/revoke commands and response validation; test CLI behavior.
- [x] Update deployment documentation and installed skill; run TypeScript, Worker,
      native tests, bundle verification, formatting and docs checks.

## Review focus

- Concurrent acceptance must grant once and never re-enable revoked access.
- A valid signed email from a different issuer must not claim an invitation.
- Existing shared principals must not grant other identities new access.
- Reader-front authentication must remain restricted to reader routes.
- Prompt rendering must escape values and clipboard failure must permit manual copying.

## Recipient UI correction

The administrator forwards the connection prompt with the invitation. The
recipient page displays only their email and effective workspace list. Reloading
an accepted invitation reads current grants without granting or re-enabling access.

## Persistent namespace grants

Invitation scope preserves requested namespace masks such as `amplifier-*` so
projects published later inherit access. Exact slugs still require an existing
workspace; global `*` and malformed globs are rejected. Status reports stored
grants; the recipient page reports effective published workspaces.
