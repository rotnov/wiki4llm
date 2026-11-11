# Connect a repository to GitHub Actions

Use this procedure to install wiki4llm ingestion in a consumer repository and
prove that its workflow can update the intended index. Creating a YAML file alone
is not completion. Use `examples/github-actions/call-ingest.yml` as the starting
point and `docs/github-actions.md` as the authoritative input/secret contract.
Paths in this reference are relative to the wiki4llm checkout unless qualified.

## 1. Establish the consumer and sources

Read the consumer repository's instructions and existing workflows. Discover its
default branch and current Actions/environments configuration. Reuse prior user
decisions about the real or test workspace, source branches, reviewed document
allowlist and whether publishing/dispatch/automatic updates are authorized.

Resolve these fields before configuring the caller:

- Consumer `owner/repository`, workflow filename and manual dispatch ref.
- Workspace, OpenAI project, complete collection/store ownership, backend origin.
- For every collection: repository, source branch, include/exclude globs and
  optional extension allowlist. Equal paths in separate collections are valid.
- Publisher GitHub environment and its allowed branches/reviewer requirements.
- Tool version choice: existing approved `@main`, or matching reviewed SHA pins.

Every run updates the **entire configured workspace**. Do not omit other collections
when adding a caller for a second repository. The workflow dispatch ref selects
workflow code/config; collection `branch` selects indexed source. If asked to index
a feature branch into an existing workspace, compare it with immutable ownership
first; do not silently relabel source provenance or mutate ownership to force it.

## 2. Provision or reuse the publisher

Read the skill's access procedure before provisioning. Reuse matching ownership
and publisher grants; do not create new stores or reset an initialized workspace
for every consumer installation. A fresh workspace requires empty stores and
complete ownership provisioning first.

The publisher Access service identity must have an enabled gate publisher grant
for the intended workspace. GHA uses the **backend** origin, including when human
readers use a separate front account. The publisher is not a gate administrator.
Create or update only the intended GitHub environment and branch rules. Preserve
existing protection and unrelated secrets.

## 3. Install variables and secrets

Use the consumer template's names unless an existing convention supplies equivalent
explicit mappings. Store nonsecret values as repository variables:

| Caller value                                | Variable or secret              | Reusable workflow field |
| ------------------------------------------- | ------------------------------- | ----------------------- |
| OpenAI project ID                           | Variable `WIKI_RAG_PROJECT_ID`  | `project-id`            |
| Backend HTTPS origin                        | Variable `WIKI_RAG_GATE_ORIGIN` | `gate-origin`           |
| Publisher client ID                         | Secret `RAG_CLIENT_ID`          | `gate-client-id`        |
| Publisher client secret                     | Secret `RAG_TOKEN`              | `gate-token`            |
| Project ingestion key                       | Secret `OPENAI_RAG_KEY`         | `openai-key`            |
| Optional private-source checkout credential | Secret `RAG_GITHUB_TOKEN`       | `github-token`          |

The caller template resolves secrets in the caller context; repository secrets or
organization secrets scoped to that repository are the straightforward route.
Do not assume secrets in an unrelated environment can satisfy the caller mappings.
If using environment-scoped secrets, check how the called job receives them under
the selected environment and verify with `plan` before claiming installation.

Use the approved secret manager and GitHub's secret API or `gh secret set` via stdin;
never put secret values in command arguments, YAML, chat, PRs or logs. Verify secret
names and variable values without reading back secrets. Pass explicit secret
mappings, not `secrets: inherit`. No Cloudflare management/admin key belongs here.

Omit the optional checkout token for the caller repository and accessible public
sources. Other private repositories require contents-read access to every configured
source (and private tool/config repository, if any); prefer the existing approved
GitHub App or fine-grained token. Checkout access is separate from gate access.

## 4. Install a reusable-workflow caller

Adapt the existing template in the consumer's `.github/workflows/` instead of
forking the ingestion implementation. Supply `workspace`, `project-id`,
`gate-origin`, all `collections`, limits and the chosen `environment` through
`with:`. Do not require TOML when the user chose workflow inputs. Keep
`permissions: contents: read`; the shared workflow owns checkout and its DO lease.

The complete caller template is manual-only and defaults its `mode` selector to
`plan`; it already passes the chosen mode to the reusable workflow. Copy that
template without adding a push trigger for a new pilot unless automatic ingestion
is already authorized. The reusable workflow itself retains its `sync` default;
the caller's explicit mode is what makes this pilot a preview.

Once accepted, add `push.branches` with the actual default branch for after-merge
updates, retaining `workflow_dispatch`. The template's existing mode expression
uses the selected mode for manual runs and `sync` for pushes.
If path filters are requested, include selected files and workflow/config changes;
one repository's trigger does not observe pushes to another repository.

Retain the approved `@main`/`tool-ref: main` choice, or use the same full SHA for both
pins. Do not silently switch versions. Validate the consumer YAML using its required
checks, inspect the diff and follow its commit/PR rules. Do not merge solely to
make a manual test possible when the user requested a pre-merge run.

## 5. Dispatch and verify, not just configure

For `gh`, set nonsecret `CONSUMER_REPO`, `WORKFLOW_FILE` and `DISPATCH_REF` first:

```sh
gh workflow run "$WORKFLOW_FILE" --repo "$CONSUMER_REPO" --ref "$DISPATCH_REF" -f mode=plan
```

Locate the corresponding run by workflow, event, ref and creation time. Record its
run ID/URL and source revisions; do not attach an unrelated recent run as evidence.
Watch that run to completion and inspect aggregate selection/authentication results.
If GitHub has not registered a new workflow for dispatch, inspect its visibility
and registration before retrying; do not silently merge or create another repository.

After a successful plan and explicit authorization to publish, dispatch `mode=sync`
against the same reviewed
configuration, wait for completion, and record the publication ID. Repeat sync on
the same source commits, selected bytes and processing configuration: expect zero
additions/replacements/deletions and unchanged publication identity. Verify actual
source revisions in both runs. A new commit outside the selected files can advance
publication metadata while reusing every file ID; that is not a failed no-op test
of the same snapshot, because the source revision changed.
Use the real MCP reader to query a known indexed phrase and `get` its exact returned
reference. Confirm the indexed repository/path and source revision.

Manual feature dispatch also requires the selected environment to allow that branch.
Use narrowly scoped temporary permission only when authorized and remove it afterward.
PR/tag contexts cannot ingest. Preserve permanent publisher access. Keep automatic
push disabled until its requested rollout point; enabling it and merging are separate
actions from preparing the workflow.

Report the consumer workflow/PR link, environment, source branches, installed secret
names (never values), plan/sync/no-op run URLs, publication and MCP result. Distinguish
prepared, pushed, merged, manually tested and automatic ingestion enabled. If a run
fails after publication, retain authority state and follow reconciliation; never
restore a runner cache or commit journal state to Git.
