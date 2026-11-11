---
name: wiki4llm
description: >-
  Deploy and operate wiki4llm on Cloudflare Workers with Durable Objects
  and Access Managed OAuth. Use when setting up or upgrading the gate, managing
  reader invitations, recipient onboarding, reader or publisher permissions, connecting Claude or ChatGPT/Codex MCP clients
  including Codex Cloud through a cloud plugin and a published environment,
  installing reusable GitHub Actions in consumer repositories, configuring manual
  and after-merge indexing with inputs and secrets, rotating credentials, or diagnosing access
  and indexing failures. Also use for WikiRack or WikiRag operations requests.
  This skill does not authorize deployments, permission changes, or data uploads
  beyond the user's requested scope.
license: MIT
disable-model-invocation: true
compatibility: Requires Git, uv with Python 3.14, Node 24+, and authorized Cloudflare/OpenAI access for hosted operations.
---

# wiki4llm operations

Operate the existing installation before proposing new infrastructure. This
repository is `wiki4llm`; its ingestion command is `wiki-rag`; the gate lives in
`gate/`. The hosted target uses OpenAI Retrieval, not a QMD container or local GPU.
Invoke this operational skill for an explicit user request; it includes credential
revocation and other state-changing procedures, not an unattended background job.

## Installed skill and repository paths

The skills installer copies this folder and its references, not the repository.
Read bundled references relative to this file. Repository paths in those references
refer to a separate wiki4llm checkout, never the skill installation directory or an
unrelated current project. For source-dependent operations, locate an authorized
checkout of `https://github.com/rotnov/wiki4llm` and read its instructions first.
For documentation-only guidance without a checkout, use the source links below.
Installing this skill does not configure MCP, grant access or deploy the service.

## Establish scope and the installation

1. Read the repository's `AGENTS.md` and `gate/AGENTS.md`. Identify the actual
   checkout, branch, dirty files and user-authorized target. Reuse session decisions;
   do not ask again for authorization already covering the operation.
2. Classify the task: fresh deployment, upgrade, access change, client connection,
   ingestion, or recovery. Read the matching reference below before changing state.
3. Obtain the installation inventory from the operator's protected records and
   verify the relevant Cloudflare resources live. If inventory is missing, discover
   resources read-only before requesting missing choices. Never guess an account
   from a hostname or reuse a similarly named Access app.
4. Establish whether there is one backend or a separate reader front. Record both
   origins and their different roles. Select the exact account on every API call.
5. For a mutation, identify the before/after values and recovery path. Preserve
   unrelated apps, policies, IdPs, issuers and credentials. A documentation request
   does not authorize a deployment; an access request does not authorize uploads.

Keep the inventory and receipts in ignored `gate/.data/` or `.smoke/`, or the
operator's protected system of record. Check ignore status before writing there.
Record identifiers, secret **names**, checked source revision and acceptance
results; never record secret values, OAuth codes, assertions or document bodies.

Use **wiki4llm** in user-facing names and instructions. Preserve existing command
and infrastructure identifiers until a compatible migration is implemented.

## Load only the relevant procedure

| Task                                                                   | Read next                                                  |
| ---------------------------------------------------------------------- | ---------------------------------------------------------- |
| First deployment, upgrade, separate-account front, rollback            | [Deployment and topology](references/deployment.md)        |
| Invitation links and recipient onboarding                              | [Invitations and setup prompts](references/invitations.md) |
| Reader/publisher grants, revocation, OAuth, client connections         | [Access and clients](references/access.md)                 |
| Connect Wiki RAG to Codex Cloud and verify real tool calls             | [Codex Cloud connection](references/codex-cloud.md)        |
| Connect a repository to GitHub Actions; manual or after-merge indexing | [GitHub Actions onboarding](references/github-actions.md)  |
| Index/update, incidents, acceptance report                             | [Ingestion and diagnostics](references/operations.md)      |

All repository paths below are relative to the checkout root. Follow the linked
source documents rather than copying their schemas into new scripts:

| Concern                                                 | Authoritative route                                                                                                                                                                       |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| End-to-end installation                                 | [docs/deployment.md](https://github.com/rotnov/wiki4llm/blob/main/docs/deployment.md)                                                                                                     |
| Worker deployment and temporary administrator lifecycle | [gate/docs/deployment.md](https://github.com/rotnov/wiki4llm/blob/main/gate/docs/deployment.md)                                                                                           |
| Identity, front Worker, admin API                       | [gate/docs/cloudflare.md](https://github.com/rotnov/wiki4llm/blob/main/gate/docs/cloudflare.md)                                                                                           |
| Ingestion state and ownership                           | [docs/remote-state.md](https://github.com/rotnov/wiki4llm/blob/main/docs/remote-state.md), [protocol](https://github.com/rotnov/wiki4llm/blob/main/gate/docs/ingestion-state-protocol.md) |
| GHA inputs and source branches                          | [docs/github-actions.md](https://github.com/rotnov/wiki4llm/blob/main/docs/github-actions.md)                                                                                             |
| CLI examples                                            | [examples/deployment](https://github.com/rotnov/wiki4llm/tree/main/examples/deployment)                                                                                                   |
| Verification                                            | [docs/development.md](https://github.com/rotnov/wiki4llm/blob/main/docs/development.md)                                                                                                   |

## Credentials and authority

Prefer the connected Cloudflare API tools for resource operations. Discover the
current API schema before writing. If credentials are needed on the operator host,
use its approved secret-manager integration; on a host providing
`mcp-hub-keychain`, load that skill. Do not assume a particular Mac, keychain name
or secret name exists on another installation.

Keep these roles distinct:

| Role                         | Credential and authorization                                                     |
| ---------------------------- | -------------------------------------------------------------------------------- |
| Deployment operator          | Scoped Cloudflare management credential                                          |
| Temporary gate administrator | Backend Access service identity plus exact `ADMIN_IDENTITIES` allowlist          |
| Human MCP reader             | Managed OAuth plus issuer-scoped identity mapping to an enabled reader principal |
| CLI/GHA publisher            | Access service-token pair plus enabled publisher grant                           |
| Separate-account transport   | Backend Access service token; no reader, publisher or admin grant                |
| OpenAI ingestion             | Project key for Files/Vector Stores writes                                       |
| OpenAI retrieval             | Separate project query key in a named Worker secret                              |

Read-all permission is not administration. A successful Cloudflare login does not
create a gate grant. An OpenAI organization admin key is never a runtime key.

## Operational traps

- **Data is in the authority, not the repository.** Keep the existing Worker,
  namespace, fixed `authority-v1` object and primary issuer/audience. A source
  rename or new login hostname must not silently create an empty replacement.
- **Publisher grants are not discoverable through admin status.** Obtain their
  complete current configuration from protected operator records before replacing
  an existing grant. A successful publisher preview does not reveal all its rights.
- **Reader front and backend differ.** The front exposes `/mcp`, `/identity` and the
  authenticated invitation browser routes. Administration and ingestion still use the backend origin.
- **Identity is issuer plus subject.** Read `/identity` after real authentication;
  never infer a subject from email or copy it from another Access team.
- **OAuth callbacks must be exact.** Copy the actual client's callback from its
  UI/discovery and add it to that app's DCR allowlist. Do not enable wildcard
  redirects or Google login merely to make an email-code connection work.
- **OAuth has several clocks.** Browser session, access-token lifetime and grant /
  refresh-token lifetime are different settings. Refresh is an HTTP exchange, not
  an LLM inference charge. Read back requested durations; do not promise permanence.
- **A deploy receipt is not activation.** For administrator bootstrap/revocation,
  use the documented immediate activation and verify the exact active version.
- **Secrets can disappear on redeploy.** Preserve existing secret names using the
  pinned toolchain's `secrets.required` mechanism and verify bindings, not values.
- **A UI error can follow a successful write.** Inspect the installed plugin or
  created resource before retrying. Resume an existing connection; avoid duplicates.
- **Cloud plugin and local MCP are distinct.** Local Codex TOML does not establish
  cloud availability. Tool discovery does not establish successful document access.

## Finish with evidence

Report the exact scoped change and evidence separately:

1. Source/configuration checks and reviewed revision.
2. Provider write/readback and deployed version, where applicable.
3. Real client OAuth and discovered tool names.
4. Authorized retrieval and denied-access checks actually executed.
5. Ingestion publication/no-op results, where applicable.
6. Temporary operator cleanup, rollback status and any remaining blocker.

Never equate a green local suite, HTTP redirect, connected badge or published
Worker with end-to-end acceptance. If a client or cloud environment cannot run,
name that boundary explicitly instead of testing a different client and calling
it equivalent.
