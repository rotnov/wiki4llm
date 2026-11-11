# Shared GitHub Actions ingestion

The reusable workflow is [`.github/workflows/ingest.yml`](../.github/workflows/ingest.yml).
It accepts configuration and credentials from a caller repository, checks out every
source in that workspace, and runs the existing remote ingestion engine. No local
index-state artifact or state commit is required.

Install [the caller template](../examples/github-actions/call-ingest.yml) in each
trusted consumer repository. It follows `@main`, with the tool checkout also using
`main` by default. This intentionally trusts future upstream changes with the
caller's supplied credentials. Each run logs the resolved tool commit. The two
branch resolutions can observe different commits if upstream changes mid-run; for
reproducible execution, set both `uses:` and `tool-ref` to the same full commit SHA.
Other symbolic tool refs are rejected. No release tag is required.

The caller template has only `workflow_dispatch`, with a `mode` selector defaulting
to `plan` and an explicit mapping to the reusable workflow. Copying it does not
enable push ingestion. Qualify manual plan, authorized sync, repeat sync at the same
source revisions/configuration, and real MCP retrieval first. For approved automatic
updates, add `push.branches` for the consumer's actual default branch alongside
`workflow_dispatch`; the existing mode expression selects `sync` for pushes.
The reusable workflow's own default remains `sync` for callers that omit `mode`.

## Inputs

All nonsecret configuration can be supplied in the caller job's `with:` block;
no TOML file or configuration checkout is needed in that mode.

| Input                | Default              | Meaning                                                               |
| -------------------- | -------------------- | --------------------------------------------------------------------- |
| `workspace`          | Empty                | Workspace slug; selects direct configuration with the next two inputs |
| `project-id`         | Empty                | OpenAI project identifier                                             |
| `collections`        | Empty                | JSON array of collection objects                                      |
| `max-files`          | 10000                | Maximum selected files, across all collections                        |
| `max-file-bytes`     | 2000000              | Maximum size of one selected file                                     |
| `max-total-bytes`    | 50000000             | Maximum total selected bytes                                          |
| `chunk-size`         | 800                  | Chunk size in tokens                                                  |
| `chunk-overlap`      | 400                  | Overlap in tokens, at most half the chunk size                        |
| `gate-origin`        | Required             | Exact HTTPS origin without a path or trailing slash                   |
| `mode`               | `sync`               | `sync` publishes incrementally; `plan` reads without provider writes  |
| `lease-wait-seconds` | 300                  | Lease wait, integer from 0 to 1800                                    |
| `environment`        | `wiki-rag-publisher` | GitHub deployment environment                                         |
| `tool-repository`    | `rotnov/wiki4llm`    | Tool repository                                                       |
| `tool-ref`           | `main`               | Follow upstream, or supply a full commit SHA                          |
| `config`             | Empty                | Optional committed TOML path, instead of direct configuration         |
| `config-repository`  | Caller               | Optional separate repository for TOML configuration                   |
| `config-ref`         | Triggering SHA       | Required when using another config repository                         |

Each collection has `name`, `repository`, `branch`, `vector_store_id`, `include`
and `extensions`, plus optional `exclude`. Include/exclude values and extensions
are arrays; repository names are `owner/repository` and branches are explicit.
Do not supply `root`: the runner owns the disposable source directories. Shared
TOML validators enforce the same identifiers, glob rules, limits and unique
collection/store bindings. Credentials remain under `secrets:`, never in inputs.

For existing TOML callers, set `config` instead. If neither direct inputs nor
`config` are supplied, the historical `wiki-rag.toml` default is used. Direct
inputs cannot be mixed with `config`, `config-repository` or `config-ref`.
Limits/chunking inputs apply to direct configuration; TOML owns those values in
file mode. Local CLI TOML support is unchanged.

Each distinct repository/branch is cloned once with full history. All collections
must be prepared before the engine publishes anything. The gate's remote authority
still verifies the complete workspace/project/collection bindings; caller inputs
do not grant access. The engine rejects stale or divergent snapshots under its
lease. A caller updates the whole configured workspace, not just its own repository.

## Secrets passed by the caller

| Secret           | Requirement                             | Destination                                              |
| ---------------- | --------------------------------------- | -------------------------------------------------------- |
| `gate-client-id` | Required                                | Cloudflare Access service-token client ID                |
| `gate-token`     | Required                                | Matching Access client secret, with publisher permission |
| `openai-key`     | Required for `sync`; omitted for `plan` | Project-scoped OpenAI ingestion                          |
| `github-token`   | Optional                                | Checkout of tool, configuration and source repositories  |

The gate token is the Access service-token secret, not an OpenAI key or a generic
Bearer token. Its identity needs an enabled publisher grant for the configured workspace.
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

The job accepts automatic pushes only from the caller's default branch. Manual
`workflow_dispatch` may select a branch permitted by the configured GitHub
environment; tags and PR events are rejected. Environment branch policies remain
the operator-controlled publishing boundary. A manual run uses the chosen branch's
workflow/config but still reads each collection's explicitly configured source
branch. It rejects other contexts before steps, uses Python 3.14/uv and a frozen dependency
set, and has a 30-minute timeout. Configure the selected environment's protections
and scope its secrets to trusted publishing jobs before installation.

In TOML mode, the configuration must be a regular tracked file whose bytes match
its checked-out HEAD. In direct mode, the environment-authorized workflow supplies
parameters through the input environment; no generated file bypass is used. All collections must be cloned successfully before the engine starts; a
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

Job logs contain aggregate counts, configured workspace/collection labels and Git
revisions. Changed and excluded file paths, skip details and operation identifiers
are omitted: even a file excluded from indexing can have a sensitive filename.
This changes diagnostics only; selection, manifests and deletion reconciliation
retain their complete internal data. The local composite uses `--summary` for the
same output boundary. Detailed local CLI previews and status are intended for
trusted local inspection, not CI logs.

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
