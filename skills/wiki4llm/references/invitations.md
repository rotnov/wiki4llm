# wiki4llm email access and recipient setup

## Invitation workflow

The administrator supplies an email and workspace scope. Create an email-bound,
one-time invitation link through the deployed gate, read back its state and return
it privately. After Cloudflare browser authentication, the invitation page
activates permissions for the signed identity and displays a ready-to-copy English
MCP prompt. No separate acceptance button is required. Do not send mail unless the
user explicitly requests it.

Read [access procedures](access.md) for administrator setup and existing permissions.
The authoritative API, deployment prerequisites and permission merge behavior are in
[gate invitations](https://github.com/rotnov/wiki4llm/blob/main/gate/docs/invitations.md).
Check the deployed version supports invitations before issuing commands. Local
implementation or a successful source publication is not a Worker rollout.

## Resolve scope and create

Resolve the actual installation, recipient and workspace scope from the request
and authorized inventory. Treat examples as examples. For “all Amplifier
workspaces”, resolve the intended current workspace list; do not infer ownership
from email domains or use global `*`. Invitations accept exact published workspace
slugs, not wildcard grants or automatic future-workspace membership.

Check that Access permits the recipient to authenticate, without broadening the
policy implicitly. Confirm the reader origin and identity realm. Preserve existing
permissions: acceptance snapshots the recipient's grants into a private principal,
preserves denies and does not change peers sharing the previous principal. Disabled
identities or principals are not re-enabled. Read-all is not administration.

From `gate/`, prepare a private JSON file with `email`, `workspaces`, and optional
`expiresInSeconds` (default seven days), then run:

```sh
npm run admin:worker -- "$GATE_ORIGIN" invite .data/invite.json
```

Use the returned ID in a private `{id}` JSON file and read back the exact grant:

```sh
npm run admin:worker -- "$GATE_ORIGIN" invite-status .data/invite-id.json
```

Return the actual link, scope and expiry. Never fabricate links or log/store tokens
in tracked files. A lost creation response requires checking operator records;
raw links cannot be recovered through status. Keep `pending`, `accepted`, and real
client retrieval verified as separate outcomes.

For revocation before acceptance:

```sh
npm run admin:worker -- "$GATE_ORIGIN" invite-revoke .data/invite-id.json
```

After acceptance, revoke the identity or principal through the existing access
procedure. A consumed link cannot be used to restore access. Expiry of the link
does not revoke previously granted permissions.

## Install the skill for coding agents

Once the skill is published, install it for both Codex and Claude Code:

```sh
npx skills add rotnov/wiki4llm@wiki4llm --agent codex claude-code
```

Do not claim an unpublished skill was installed. Installing the skill and
connecting MCP are separate steps. Keep the installation command outside the
recipient invitation template. The installer requires compatible Node/npm;
hosted readers do not need the ingestion CLI, a server deployment, a repository
clone or OpenAI/Cloudflare management keys.

## Prepare the recipient invitation

Use this single English template for both Claude and Codex. Substitute a verified
HTTPS reader MCP URL, recipient email and expected workspace list. Never guess a
hostname or use the administration origin. If values are missing, label the prompt
as a draft and retain the uppercase placeholders. Do not include operator secrets.
The email is for wiki4llm authentication, not necessarily the AI client's account.

```text
Connect wiki4llm MCP as a web connection: {MCP_URL}.
Use {EMAIL} to sign in; I will complete the browser authentication myself.
After connecting, verify access to {WORKSPACES} and retrieve a document.
```

## Agent connection procedure

Determine the actual client surface and use [access procedures](access.md).
Inspect existing MCP entries and reuse a matching connection without silently
overwriting a different server. Use remote HTTP/OAuth, not a local stdio server.
Leave browser authentication to the user; never ask for passwords or login codes
in chat. Verify workspace discovery and document retrieval, and report actual
results or remaining blockers. Do not deploy, index data or change permissions
as part of recipient setup.

Claude Desktop/web uses a remote custom connector rather than Claude Code's CLI.
For Codex Cloud, use [the cloud procedure](codex-cloud.md); local CLI configuration
does not connect a cloud environment. A Connected badge or tool discovery alone
is not retrieval verification.

Command references checked on 2026-11-11:

- [Claude Code remote MCP and authentication](https://code.claude.com/docs/en/mcp)
- [Codex MCP configuration and OAuth](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- [Skills installation](https://github.com/vercel-labs/skills#install-a-skill)
