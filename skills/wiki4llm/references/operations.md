# Ingestion and diagnostics

Use this reference for indexing, shared GitHub workflows and incident triage.
The source of truth is `docs/remote-state.md`, `docs/github-actions.md` and
`gate/docs/ingestion-state-protocol.md`; consult those files for exact schemas.

## Ingestion lifecycle

The CLI updates a **whole configured workspace**, possibly containing several
repositories. It compares captured content/configuration with the durable journal;
it does not blindly upload everything or rely only on the triggering Git diff.
Updates with identical source revisions, selected bytes and processing configuration
preserve publication identity. A new source commit can advance publication metadata
without uploading any new files. Remote state, leases and publication
live in the DO: no runner commits state to Git, and no Actions cache is authoritative.

Before initial indexing, provision fresh empty stores and the exact project,
collection, repository/branch and store bindings. The current protocol cannot adopt
a populated legacy store, a lost local journal or a manually imported publication.
Adding or removing collections under existing ownership is not an in-place feature.

Before bulk ingestion, inspect the Workers plan, current Durable Object SQL usage
and [included quotas](https://developers.cloudflare.com/durable-objects/platform/pricing/).
File counts and HTTP request counts are not SQL-write estimates: durable state
transitions, receipts and indexes write multiple rows per file. A shared authority
can make quota exhaustion visible to multiple workspaces. Preserve its journal
and resolve capacity before repeating a quota-failed run.

For a partially applied attachment batch, the CLI reports found/expected counts
and missing metadata fields without exposing values. It can restore exactly empty
attributes on an acknowledged owned upload after source/receipt, File identity and
chunking checks, followed by readback. Conflicting nonempty attributes and missing
attachments remain unresolved; inspect the evidence instead of changing journal
phases manually. See `docs/remote-state.md` for the precise recovery boundary.

Run from the repository root with nonsecret `RAG_CONFIG` set to the reviewed TOML
path and credentials injected through the documented environment variables:

```sh
uv run wiki-rag --config "$RAG_CONFIG" status
uv run wiki-rag --config "$RAG_CONFIG" plan
uv run wiki-rag --config "$RAG_CONFIG" index --apply
uv run wiki-rag --config "$RAG_CONFIG" index --apply
```

`index --apply` initializes or resumes/converges; `update --apply` requires initialized
state. A remote preview reads the authority but makes no provider writes. Inspect
selection before an approved upload. Ordinary candidates are Git-tracked;
explicit verified LFS and generator sources follow
[derived sources](https://github.com/rotnov/wiki4llm/blob/main/docs/derived-sources.md), never a generic untracked-file bypass.
include globs must match, an optional extension allowlist further restricts them,
and excludes win. Remote mode
requires full committed history and literal HEAD bytes or the configured derived proof, with ancestry
checks. Do not disable these guards to run a dirty or divergent source.

Each collection retains a stable repository identity. Equal filenames across
repositories are not collisions: preserve collection/repository/path metadata and
use exact references returned by `query` for `get`, not basename guesses.

## Shared GitHub Actions

Use `examples/github-actions/call-ingest.yml` and the contract in
`docs/github-actions.md`. Inputs select workspace, OpenAI project, all collections,
backend gate origin and `mode`. TOML is an alternative; do not mix both modes.

- `gate-client-id` / `gate-token`: the scoped publisher Access pair.
- `openai-key`: project ingestion credential for sync, unnecessary for plan.
- `github-token`: optional; the built-in token covers the caller and accessible
  public sources. Additional private repositories need appropriate contents-read
  access. It is not the gate authentication token.

The caller template follows `@main`, which trusts future tool updates with caller
credentials. Preserve an existing explicit version decision. For reproducible
execution, pin workflow and tool checkout to the same reviewed SHA; do not silently
change an operator's chosen contract.

The caller template is manual-only and defaults to `plan`. Run approved `sync`,
record the submitted job ID. The reusable workflow waits up to five minutes for
that exact job through gate status, without polling OpenAI or holding a lease.
Failure or timeout makes GHA red with a reason. A timeout does not cancel indexing:
inspect MCP `status` or publisher `status --summary` before retrying. Direct CLI
sync remains asynchronous. Then repeat sync at the same source revisions/configuration and check MCP before
enabling an authorized push trigger. Automatic pushes must be from the default branch; manual branch dispatch must
be allowed by the selected GitHub environment. PR/tag contexts are rejected. The
dispatched workflow branch and each collection's configured source branch are
different: report the actual indexed revision, not the workflow's revision.

For an already-published workspace, MCP `status` also exposes the latest `indexing`
job with progress, sanitized errors and timing. `documents` counts the active
publication, not the pending candidate. `finished_at` and `duration_ms` are null
while pending and for legacy jobs whose finish time was not recorded. A failed
job is terminal; do not describe it as still indexing or infer its duration from
the shorter GitHub submission step. Gate status does not push a notification;
the workflow's bounded observer translates it into GitHub success or failure.

For a requested pre-merge test, use the existing manual workflow path; do not invent
a separate repository or corpus unless isolation is requested. Confirm whether the
test targets the real workspace. Remove temporary branch permissions afterward;
leave permanent publisher credentials and unrelated environment rules intact.

## Evidence ladder

1. Read back deployment version, authority identity and relevant grants.
2. Confirm unauthenticated MCP denial with OAuth discovery.
3. Complete real client OAuth and list all five read-only tools.
4. Query a known phrase; read its returned reference and verify provenance. Exercise
   pagination or `multi_get` where relevant. Compare content in memory; log only
   counts/digests and nonsecret references in protected receipts.
5. With a restricted identity, reject an out-of-scope workspace/reference.
6. Verify initial publication, unchanged no-op and incremental replacement when
   the task includes ingestion qualification. A rename/deletion test uses an
   approved disposable corpus, never unrequested production document changes.
7. Verify temporary administrator revocation and unchanged unrelated applications.

Distinguish local mock/workerd tests, hosted tool discovery, actual provider reads,
and client-specific cloud acceptance. Do not claim refresh/expiry or a backup restore
was tested merely because its configuration is present.

## Diagnose by boundary

| Symptom                                           | Evidence and next action                                                                                                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| No OAuth challenge or HTML login redirect         | Verify whole-origin Access application and Managed OAuth; inspect the exact challenged resource metadata.                                   |
| ChatGPT rejects settings before login             | Check discovered OAuth endpoints, DCR and exact client callback allowlist. Preserve authentication.                                         |
| UI reports network failure after creation         | Inspect the installed resource and resume its connection before retrying creation.                                                          |
| Login works but tools have no content             | Verify issuer/key mapping, enabled principal, grants, first publication and selected workspace.                                             |
| Wrong login branding                              | Check account team domain; use the existing separate-front architecture for one-app isolation.                                              |
| Operator gets 403 after deploy                    | Verify typed service identity and immediate activation before expanding permissions.                                                        |
| Publisher gets 403                                | Check Service Auth, publisher identity/grants and backend origin, not reader OAuth.                                                         |
| Front returns 502/503                             | Inspect backend reachability, inherited bridge/query secret names, exact `MCP_FORWARDER` identity and issuer/audience; never print secrets. |
| Authority fails after issuer/audience change      | Restore the intended binding; do not reset the DO or silently migrate grants.                                                               |
| Store ownership/init refusal                      | Check immutable bindings and empty-store precondition; retain journal and investigate.                                                      |
| Lease, stale revision or divergent source failure | Obtain the correct fresh committed source and resume normally; do not replace authority with a cache.                                       |
| Unknown create/upload outcome                     | Reconcile the persisted intent and resource IDs before another create.                                                                      |
| Publication committed but cleanup failed          | Preserve the committed receipt and journal; resume cleanup rather than restarting the index.                                                |
| Tools work locally but not in cloud               | Inspect cloud installation/auth and environment publication; local configuration is not evidence of cloud support.                          |

Consult `docs/development.md` for checks after source changes. For a docs/skill-only
change, validate skill format, links, documented commands, formatting and the staged
public payload; do not redeploy or run paid indexing to prove a prose change.
