# wiki4llm email access and recipient setup

## Invitation workflow

The administrator supplies an email and workspace scope. Create an email-bound,
one-time invitation link through the deployed gate, read back its state and return
it privately. After Cloudflare browser authentication, the invitation page
activates permissions for the signed identity and displays its effective workspace
list. The administrator receives the English MCP prompt in the creation result
and forwards it to the teammate as a single block containing the invitation link. No separate acceptance button is required. Do not send mail unless the
user explicitly requests it.

Read [access procedures](access.md) for administrator setup and existing permissions.
The authoritative API, deployment prerequisites and permission merge behavior are in
[gate invitations](https://github.com/rotnov/wiki4llm/blob/main/gate/docs/invitations.md).
Check the deployed version supports invitations before issuing commands. Local
implementation or a successful source publication is not a Worker rollout.

## Resolve scope and create

Resolve the actual installation, recipient and workspace scope from the request
and authorized inventory. Treat examples as examples. For “all Amplifier
workspaces”, verify the actual namespace and preserve the requested prefix mask
(e.g. `amplifier-*`) verbatim. Do not expand it to a snapshot of current workspace
names: future matching projects must inherit access. Do not infer a namespace
from email domains or substitute global `*`. Exact slugs must already be published;
prefix grants can precede publication. Confirm stored masks in the status readback,
and distinguish those grants from the current effective workspace list on the page.

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

Return the complete generated prompt with the actual invitation link inside it, plus scope and expiry. Never fabricate links or log/store tokens
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
invitation URL returned by the gate, HTTPS reader MCP URL, recipient email and
workspace scope. Keep the invitation URL inside the prompt so forwarding only the
code block does not omit activation. Never guess a
hostname or use the administration origin. If values are missing, label the prompt
as a draft and retain the uppercase placeholders. Do not include operator secrets.
The email is for wiki4llm authentication, not necessarily the AI client's account.

```text
First, open this wiki4llm invitation:
{INVITATION_URL}

I will sign in as {EMAIL}. Wait until the page shows "Access granted".

Then use computer use to add wiki4llm as a web connector through the application UI:
{MCP_URL}

Do not use local config files or CLI commands. If prompted, I will authenticate again with the same email.

Finally, verify access to {WORKSPACES} and retrieve a document.
```

## Agent connection procedure

First open the invitation and wait for **Access granted**. OAuth sign-in to the
MCP connector alone does not activate an invitation or assign reader permissions.
Then determine the client surface and use [access procedures](access.md).
For this invitation flow, use computer use to add a hosted web connector in the
application UI. Do not substitute local MCP configuration or CLI registration.
If computer use or web connectors are unavailable in the chosen client, explain
the specific limitation and request a supported surface instead of changing modes.
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
