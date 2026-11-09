# Shared GitHub Actions ingestion

The reusable workflow is [`.github/workflows/ingest.yml`](../.github/workflows/ingest.yml).
It accepts configuration and credentials from a caller repository, checks out every
source in that workspace, and runs the existing remote ingestion engine. No local
index-state artifact or state commit is required.

Install [the caller template](../examples/github-actions/call-ingest.yml) in each
trusted consumer repository. Use a reviewed commit published to `rotnov/wiki4llm`;
no `v1` tag is required or assumed.
Replace both `REVIEWED_COMMIT_SHA` occurrences with the same full commit SHA and
adapt the trigger to the caller's default branch. Keep that pair together when
upgrading: reusable workflows execute in the caller's repository context, so the
tool checkout needs an explicit independent revision.

## Inputs

| Input                | Default               | Meaning                                                               |
| -------------------- | --------------------- | --------------------------------------------------------------------- |
| `config`             | `wiki-rag.toml`       | Committed TOML path inside the configuration repository               |
| `gate-origin`        | Required              | Exact HTTPS gate origin, without a path or trailing slash             |
| `tool-ref`           | Required              | Full 40-character reviewed tool commit; match workflow revision       |
| `tool-repository`    | `rotnov/wiki4llm`     | Published tool repository, or an authorized fork                      |
| `mode`               | `sync`                | `sync` converges the index; `plan` previews without provider requests |
| `lease-wait-seconds` | `300`                 | Initial lease contention budget, integer 0–1800                       |
| `config-repository`  | Caller repository     | Optional shared configuration repository                              |
| `config-ref`         | Triggering commit SHA | Explicit ref required when config is in another repository            |
| `environment`        | `wiki-rag-publisher`  | Caller repository environment for deployment protections              |

Workspace, OpenAI project, collection/store identities, repository branches,
include/exclude globs and extensions remain in the TOML. All source branches must
be explicit. Each distinct repository/branch is cloned once with full history.
The runner replaces collection roots in memory with disposable checkout paths;
the TOML's `root` fields remain useful for local operation and are not CI paths.

For a shared workspace, keep one authoritative TOML in a trusted configuration
repository. Each caller may pass `config-repository`, an explicit `config-ref`, and
`config` to use it. The source revisions still come from the configured branches;
the remote engine rejects stale or divergent source snapshots under its lease.

## Secrets passed by the caller

| Secret           | Requirement                             | Destination                                              |
| ---------------- | --------------------------------------- | -------------------------------------------------------- |
| `gate-client-id` | Required                                | Cloudflare Access service-token client ID                |
| `gate-token`     | Required                                | Matching Access client secret, with publisher permission |
| `openai-key`     | Required for `sync`; omitted for `plan` | Project-scoped OpenAI ingestion                          |
| `github-token`   | Optional                                | Checkout of tool, configuration and source repositories  |

The gate token is the Access service-token secret, not an OpenAI key or a generic
Bearer token. Its identity needs an enabled publisher grant for the TOML workspace.
No gate administrator credential is used by ingestion.

When `github-token` is omitted or empty, the workflow uses the caller's built-in
`github.token` with `contents: read`. It suffices for that repository and accessible
public sources. Other private repositories require a suitable contents-read token
(for example, a GitHub App installation token or fine-grained PAT). The same
requirement applies to a private tool or configuration repository. Pass a token only
when those additional reads are needed; it is not used for gate or OpenAI requests.

Use explicit `secrets:` mappings as shown in the template. Organization secrets may
be scoped to selected caller repositories. Repository/environment access rules and
the publisher grant remain operator setup; these files do not create them.

The wrapper binds the four gate/OpenAI environment names internally. TOML custom
environment names are not required in GitHub Actions and are not written back.
Secrets are captured only by their respective HTTP clients, then removed from the
process environment during Git operations. The checkout token reaches only the
fixed GitHub HTTPS transport through a command-scoped header. It is not written to
Git configuration, command arguments, manifests or workflow outputs.

## Execution and outputs

The job accepts only a `push` or `workflow_dispatch` from the caller's default branch.
It rejects other contexts before steps, uses Python 3.14/uv and a frozen dependency
set, and has a 30-minute timeout. Configure the selected environment's protections
and scope its secrets to trusted publishing jobs before installation.

The configuration must be a regular tracked file whose bytes match its checked-out
HEAD. All collections must be cloned successfully before the engine starts; a
failed second checkout cannot publish a partial workspace. Source materialization
disables hooks, templates, filters, ident expansion, EOL/encoding transformations
and submodule traversal. The actual engine still verifies committed literal bytes
and rescans before publication.

`sync` runs idempotent `index --apply`: initialization versus incremental update is
chosen under the remote lease. `plan` acquires no lease and makes no provider
requests, although source checkout and gate publication reads require networking.
Cleanup/release failures remain fatal, including after a committed publication.

Workflow outputs:

- `workspace`: selected workspace slug.
- `publication-id`: committed publication UUID for sync, empty for plan.

GitHub concurrency uses `cancel-in-progress: false`; concurrency groups are local to
the caller repository. The Durable Object lease coordinates different callers.
This workflow does not install cross-repository event delivery or guarantee a
future retry after a missed event, timeout or stale checkout. Every run updates the
whole configured workspace, not only the repository that emitted the event.

The existing [local composite](../.github/actions/ingest/action.yml) and
[manual-checkout template](../examples/github-actions/ingest.yml) remain available
for callers that already prepare all source roots. They are separate entry points;
the new shared workflow handles source preparation itself.

References: [GitHub reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows),
[caller context](https://docs.github.com/en/actions/concepts/workflows-and-actions/reusing-workflow-configurations),
[checkout token scope](https://github.com/actions/checkout#checkout-multiple-repos-private).
