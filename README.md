# wiki4llm

Git-to-RAG knowledge for coding agents: a Python ingestion CLI, an authenticated
MCP gateway, and a reusable GitHub Actions workflow in one repository.

- **[Deploy the stack](docs/deployment.md)** — OpenAI, Cloudflare, credentials and first index.
- **[Connect a repository](docs/github-actions.md)** — workflow inputs and optional GitHub token.
- **[Operate the gate](gate/README.md)** — Cloudflare or native Node/QMD runtime.
- **[Develop and verify](docs/development.md)** — local checks and public release process.
- **[Operator skill](.claude/skills/wiki-rag-ops/SKILL.md)** — deployment, access,
  OAuth clients, ingestion and recovery procedures for agents.
- **[Public explainer](site/index.html)** — purpose and principles; [site maintenance](docs/public-site.md).

The Python command remains `wiki-rag`. It ingests Git-tracked text and explicitly
selected PDFs into OpenAI Retrieval and publishes an active-file registry for
agents. Cloudflare stores the remote journal and serves the MCP endpoint; no
persistent indexing machine is required.

Requires **Python 3.14**, managed with [uv](https://docs.astral.sh/uv/), and a
POSIX host (macOS or Linux). The lockfile pins application and development
dependencies. The CLI is an ephemeral process; the separately deployed gate lives
in `gate/`. The repository does not include a hosted account or service subscription.

For CI, the [shared GitHub Actions workflow](docs/github-actions.md) accepts
direct workflow parameters (or committed TOML) and gate/OpenAI secrets from each caller. Its separate GitHub
checkout token is optional. Consumer installation and credential setup are explicit operator steps.

## Quick start

```sh
uv sync --locked
cp wiki-rag.example.toml wiki-rag.toml
uv run wiki-rag --config wiki-rag.toml plan
```

Edit the configuration to reference a local Git repository, your OpenAI Project
and an **existing empty vector store** in that project. Set the configured
`WIKI_RAG_INGEST_KEY` environment variable through your credential-management
workflow. Never put a key in TOML or command arguments.

```sh
uv run wiki-rag index --config wiki-rag.toml --apply
uv run wiki-rag update --config wiki-rag.toml
uv run wiki-rag update --config wiki-rag.toml --apply
uv run wiki-rag status --config wiki-rag.toml
```

`--config` works before or after the subcommand. In local-state mode, `plan`,
`status`, and bare `index`/`update` make **zero remote requests** and require no
credentials. Remote-state previews make read-only authority requests.
`index --apply` initializes new ownership state; thereafter `index --apply`
and `update --apply` converge using that state. `update --apply` refuses missing
state. JSON output reports selection counts/bytes, additions, replacements,
deletions, skipped files and reasons. Exit code 2 means the operation failed;
interruption returns 130. In local mode, cleanup failures after a successful
publication are reported as `cleanup_pending` in otherwise successful JSON output.
Remote sync returns `mode: submitted` with a `job_id` after uploading and attaching;
the gate completes indexing and publication in the background. A successful submission
is not a completed index. Inspect `status --summary` for job progress. No-op syncs
return `mode: applied` with the existing publication ID. Remote cleanup runs before
submission and failures exit with code 2 while preserving the active publication.

Use `--summary` with `plan`, `index`, `update` or `status` for aggregate log output without
document or excluded-file paths. The GitHub Actions entry points use this boundary
automatically; ordinary local CLI output remains detailed. Summaries retain
configured workspace/collection labels, revisions and counts.

For installation from a built wheel:

```sh
uv build
uv tool install --python 3.14 dist/wiki_rag-0.1.0-py3-none-any.whl
wiki-rag --help
```

## Configuration and selection

See [wiki-rag.example.toml](wiki-rag.example.toml). TOML schema version 1 is strict:
unknown keys and literal API-key fields are rejected. Roots and the state
directory resolve relative to the configuration file. Parent-relative paths such
as `../handbook` and `../state` are normalized lexically; every existing component
is checked first, so a symlink in a segment later cancelled by `..` is rejected.
Each named collection
has an independent stable `repository` identity, local `root`, optional
`branch`, and existing `vector_store_id`; these are distinct concepts. Multiple
collections can contain `README.md` without collision.

Only Git-tracked paths are considered. In local mode, working-tree bytes are captured, hashed,
and uploaded; staged versions do not override working-tree contents. Each
file's `source_commit` is set only when those exact bytes match its HEAD blob;
otherwise it is null. Repository HEAD is separately recorded for ancestry and
concurrent-change guards. A configured branch must be the checked-out branch;
detached HEAD is rejected when `branch` is configured. Remote mode requires full
history, an index equal to HEAD and selected literal HEAD blob bytes; see the
[remote source policy](docs/remote-state.md#source-policy).

Include globs select paths; excludes always win. An optional `extensions` allowlist
further restricts matching files. Omit it when the globs already specify the desired
suffixes; omission adds no extension filter, while an explicit list must be nonempty.
Globs are case-sensitive, root-relative POSIX paths: `*`, `?`, and bracket
classes match within one segment; a standalone `**` segment matches zero or
more segments. `**/*.md` includes root-level Markdown. There is no brace
expansion, negation, shell expansion or configuration interpolation.

The scanner skips symlinks, Git submodules, nested repositories, `.git`, local
state, `.env*`, common credential/key names, recognized private keys and common
API-token patterns. It never follows symlinks or executes repository hooks or
fsmonitor code. These checks are a conservative baseline, not a general-purpose
secret detector; review the selected source before uploading it.

Text handling accepts UTF-8. Known text suffixes include Markdown, plain text,
reStructuredText, common source code, JSON, YAML, TOML, HTML, XML and CSV; see
`TEXT_SUFFIXES` in [selection.py](src/wiki_rag/selection.py) for the exact set.
Eligible text is sent unchanged as a uniquely named `.txt` file. The original
path and kind remain in attributes and the manifest. LFS pointers, NUL-containing
or non-UTF-8 text, and unsupported formats are reported as skipped.

PDFs are supported when include globs match and the optional extension allowlist
permits `.pdf` (or is omitted). They are sent with their original
raw bytes, a `.pdf` filename and `application/pdf` MIME type. A bounded check
requires a PDF 1.0–1.7 or 2.0 header and a trailing `%%EOF` marker within the last
1024 bytes. This is a sanity check, not structural PDF validation; provider
completed-ingestion status is still required. Invalid PDFs are reported as skipped.
PDF parsing/extraction is provider-owned (`pdf-native-v1`); no local parser runs.
Office documents, images, archives and other unsupported binary formats are never
relabelled as text.

Selected unreadable or oversized files abort before uploads. Defaults are 2 MB
per file, 50 MB total, and 10,000 selected files per run; configurable ceilings
are 20 MB, 200 MB, and 100,000 files. Limits are decimal bytes. Each selection
budget can instead be explicitly disabled with the integer `-1`:

```toml
# Top-level settings, before any [table]. Omit a setting to keep its default.
max_files = -1
max_file_bytes = -1
max_total_bytes = -1
```

Use the existing `wiki-rag --config wiki-rag.toml plan` command to inspect this
selection before `index --apply` or `update --apply`. Budgets are independent;
for example, disabling the total still leaves the default per-file/count budgets.
Zero, other negative numbers, floats and booleans are rejected. Positive integer
ranges and defaults are unchanged. The legacy TOML string `"unlimited"` remains
accepted for existing configurations; new configurations should use `-1`.
GitHub Actions accepts the same [numeric sentinel](docs/github-actions.md#selection-budgets).

**Unlimited selection budgets do not mean an unlimited service.** Remote publication
still enforces the [protocol limits](gate/docs/ingestion-state-protocol.md), including
10,000 active files across the workspace, 20 collections, an 8 MiB manifest and
100,000 journal operations including tombstones. Source/path integrity, secret
exclusions, ownership, active-file authorization and all transport/time bounds remain.
A protocol-limit error aborts the run; the scanner never silently truncates the corpus.
Local selection can exceed the remote file cap, but importing its manifest into a
gate still requires that gate's validation. OpenAI's [Retrieval limits](https://developers.openai.com/api/docs/guides/retrieval#limits)
currently specify 512 MB and 5,000,000 tokens per file; provider acceptance, quotas
and rate limits still apply. A successful plan does not establish provider acceptance.

The scanner retains all selected content in memory and captures another snapshot
before publication. Hashing, decoding and uploads add temporary allocations; peak
memory can substantially exceed the selected bytes. Disabling budgets can exhaust
RAM/disk/time or increase provider storage costs. It does not enable streaming,
automatic splitting or unbounded retries. Set finite budgets for unattended runs
unless their removal is intentional and the source size has been reviewed.

Chunking is
explicitly static: default 800 tokens with 400 overlap, configurable within
100–4096 tokens and overlap at most half the chunk size. Content hash and
per-file preprocessing and chunking configuration jointly determine a file version.

## Durability and recovery

In local mode, the private state directory is mode 0700; JSON and lock files are created with
mode 0600. One POSIX process lock serializes writes. Keep the entire directory,
including hidden `.initialized`, together on durable storage. `state.json` is a
checksummed ownership journal. `manifest.json` is the independently atomically
replaced published snapshot. State is not an evictable cache.

Initial indexing requires empty vector stores to avoid silently replacing a
lost journal or duplicating an existing corpus. Missing, corrupt or differently
bound ownership state fails closed. Collection names, repository identities,
branch bindings, project and vector stores cannot be changed under an existing
state directory. Restore the original configuration/state or create fresh empty
stores with new state. Moving a local repository root is allowed. Adding/removing
collections under existing state is deliberately outside this MVP.

Local-state ingestion uploads and attaches files serially, then polls until `completed`.
Remote ingestion uploads with eight workers, batches attachments and submits the
rescanned snapshot to the gate. CI never waits or polls for indexing; the gate
verifies completion and publishes in the background.
All configured collections publish together only after every selected file
succeeds and a second source scan matches the captured selection. The previous
manifest survives prepublication failure. Updates at identical source revisions,
selected bytes and processing configuration upload nothing and retain the publication
identity. A new repository commit may advance publication metadata while reusing
unchanged file IDs. Source revisions must descend from the last
published repository commit; stale, divergent and unavailable ancestry fails
closed. Local uncommitted updates are serialized and rescanned, but independent
workers must share one durable authority rather than clone stale state.

Creates are never automatically retried after ambiguous transport/HTTP failures.
Intent is persisted before each create and resource IDs immediately afterward.
Reruns reconcile unknown uploads using their persisted unique filename and exact
content hash, and unknown attachments using store/file IDs and operation metadata.
If no unique matching result is visible, the run stops instead of guessing.
Retry reconciliation later; unresolved outcomes require operator investigation.
Explicit rejected requests such as HTTP 403/429 may be attempted again on a
subsequent run. Reads and idempotent deletes retry at most three times with
bounded backoff. Polling makes at most 60 status checks, separated by two seconds
(and bounded read retries); resume a timed-out poll with the same state.

Confirmed terminal `failed`/`cancelled` ingestion is journaled separately from
unknown poll outcomes. The failing run preserves the prior publication. On a
subsequent run, its owned failed resources are retired before a new upload/attach
attempt begins. There are at most three ingestion attempts for an unsuccessful
logical version, counted durably across restarts. Exhaustion stops for operator
investigation; it never loops indefinitely. Timeouts, transport failures and
missing/ambiguous status do not authorize a fresh create.

After publication, cleanup deletes only journal-owned obsolete attachments and
files; IDs retained by any collection are protected. Both attachment and File
deletion intents are persisted before their respective remote requests. A version
whose retirement started cannot be reused until those idempotent deletions finish;
if deletion is unavailable, the prior publication remains active. Retired ownership
receipts are preserved before reusing a logical version key. Cleanup is restartable
and may remain pending. Unresolved obsolete create intents are retained and reported.
Do not manually share these owned file IDs with unrelated stores or modify
managed remote resources out of band. Deleted IDs remain in the journal as
recovery history; this MVP does not compact it.

For ephemeral CI runners, use the [remote authority backend](docs/remote-state.md).
Local mode requires a durable shared state volume or a central ingestion worker. Restoring a stale backup while newer writers exist
can defeat ordering; do not run multiple independent state copies against the
same stores. Native Windows and distributed/network-filesystem locking have
not been qualified.

## Permission-gate integration

The read-only contract is [docs/manifest-contract.md](docs/manifest-contract.md).
In local mode, import one complete `manifest.json` snapshot into the gate's own
authorization registry. Remote mode publishes atomically through its ingestion
authority and does not use a separate import step. Never import the private journal or infer identity from filenames.
Apply project/collection authorization and active-file filtering **before** any
retrieved content reaches a model or caller.

Remote replacement is not atomic. Staged files are remotely searchable before
publication, and provider deletion is eventually consistent. The registry lets
a gate reject both staged and stale IDs. Use separate ingestion and gate
credentials, constrained to the intended OpenAI Project. This tool sends an
explicit `OpenAI-Project` header to the fixed `https://api.openai.com/v1/` origin;
base-URL overrides, ambient proxy settings and redirects are not used. It needs
normal project Files/Vector Stores permissions, never organization admin keys.

## Development and release checks

```sh
uv sync --locked
uv run python --version
uv run pytest -q
uv run ruff check .
uv run ruff format --check .
uv build
uv run python scripts/check_public.py
```

Stage the intended payload before running the public check. It snapshots the
index with `git write-tree` and scans the resulting immutable Git blobs and modes,
not working-tree bytes. The output identifies the exact checked tree SHA; compare
it with the eventual commit tree (`git rev-parse 'HEAD^{tree}'`) and rerun after
restaging. Unstaged sanitizing edits cannot hide staged sensitive content.
Pass repeatable `--forbid` arguments for organization-specific names or private paths. The check
reports filenames and reasons, never suspected credential contents. Review the
full staged diff, Git author metadata, dependency lock, wheel and source archive
before publication. Automated pattern checks do not establish absence of all
sensitive information. No remote publication is performed by these commands.

Tests use synthetic Git repositories, a recording fake provider and HTTPX's mock
transport. They cover selection, preview isolation, lock contention, incremental
changes, ownership, failure preservation, recovery, source provenance, fixed
origin/headers, pagination and bounded retries. A manual synthetic live procedure
is in [docs/live-smoke.md](docs/live-smoke.md); it is opt-in and may incur API
storage charges. Local tests do not claim live cloud acceptance.

API grounding: [Files upload](https://developers.openai.com/api/reference/resources/files/methods/create),
[Vector Store attachments](https://developers.openai.com/api/reference/resources/vector_stores/subresources/files/methods/create),
and [Retrieval lifecycle](https://developers.openai.com/api/docs/guides/retrieval).

Licensed under [MIT](LICENSE).

## Ephemeral runners and remote state

Use `[remote_state]` instead of `state` to keep the ingestion journal, lease and
atomic gate publication in a provisioned Cloudflare authority. A fresh runner needs
only full committed source checkouts, validated configuration and environment-backed credentials.
`index --apply` safely initializes or resumes/converges under the authoritative
lease; `update --apply` remains strict on uninitialized state. Remote previews make
read-only state requests. See [remote setup, recovery and source policy](docs/remote-state.md)
and the [shared-workflow caller template](examples/github-actions/call-ingest.yml).
