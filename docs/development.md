# Development and verification

Use Python 3.14 with uv and Node 24 or newer. Run these commands from the repository
root; npm's prefix selects the gate package without moving the Python project.

```sh
uv sync --frozen
npm ci --prefix gate
WIKI_RAG_GATE_SOURCE="$PWD/gate" uv run pytest -q
uv run ruff check .
uv run ruff format --check .
uv build
npm --prefix gate run check
npm --prefix gate run build
npm --prefix gate test
npm --prefix gate run check:worker
npm --prefix gate run test:worker
npm --prefix gate run check:bundle
npm --prefix gate run dry-run:worker
npm --prefix gate run format:check
npm --prefix gate run check:docs
```

Setting `WIKI_RAG_GATE_SOURCE` ensures the four cross-language workerd cases run;
the standalone Python-only invocation otherwise skips those optional integration
tests. Tests use temporary Git sources and synthetic provider/authentication data.
No OpenAI key, Cloudflare account or live document upload is required. The optional
native QMD model and Docker qualification commands are documented in `gate/README.md`.

For retrieval diagnostics, validate the metadata reducer in the actual orchestration
runtime before live calls with synthetic Unicode success, plain-text `isError`,
malformed JSON, `structuredContent: null` client wrappers (not a second payload), and
thrown tool errors; cover allowlisted error codes without assuming runtime globals.
Raw tool logs may retain full output while host truncation changes live model history.
Validate effective outer-output and history budgets and gap-free bounded content
after that layer; raw completeness or larger inner budgets alone are insufficient.
Caller protocols must preserve mandatory committed project guidance, including
required overlays, while distinguishing it from personal or session memory.
Record parent phase-request timestamps at dispatch; never reconstruct missing
request times from task-start events.
Persist each attempt's outcome,
error code, error message and timing, with secrets redacted and successful document
bodies excluded. Keep missing coverage distinct from measured zero coverage.
Predeclare the attempt cap and provenance (source revision, runtime, configuration
and input identifiers) before running. Retain invalid attempts and their failure
evidence; do not selectively rerun or omit attempts to improve reported results.
Store diagnostic receipts only in the ignored local locations described below.

Before publishing a commit, stage the intended files and inspect its immutable
payload:

```sh
uv run python scripts/check_public.py
git diff --cached --check
git diff --cached --stat
```

The public scan checks the proposed tree, including the gate subtree. Also review
the full diff, author metadata, examples, dependency lockfiles and built artifacts.
Automated pattern scanning cannot establish that all content is safe to publish.
Never stage private deployment files or project corpora. Local receipts belong in
ignored `.smoke/`, and gate operator data belongs in ignored `gate/.data/`.

The public CI workflow runs these core checks with read-only repository permission
and no deployment credentials. Passing CI does not establish a live Worker rollout,
OAuth login, a consumer repository's GHA installation, or provider retrieval quality.
Those have separate acceptance steps in [deployment](deployment.md).
