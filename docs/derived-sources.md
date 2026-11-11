# Verified LFS and generated documentation

Ordinary source selection still requires tracked files and, in remote mode, literal
HEAD bytes. Two opt-in collection fields support documents that are represented
indirectly in Git. Include/exclude globs, extension filters, format checks, secret
filters and selection budgets apply to their resolved documents too.

## Git LFS

Set `lfs = true` on a collection whose selected files include LFS objects. Only
canonical v1 pointers with SHA-256 OIDs and byte lengths are supported. Native
bytes must match both values. The scanner accepts an already materialized file or
a verified local LFS cache object. The reusable GHA runner can download missing
selected objects through Git LFS's basic transfer using its checkout credential.
It fixes the GitHub LFS endpoint, disables custom transfer agents/remote discovery,
and sends each selected pointer individually; repository filters and model-weight
downloads are not enabled. Declared byte/count limits are checked before transfer.

Local CLI runs do not discover credentials or download missing LFS objects. Fetch
them using your normal Git LFS setup first, or use the configured GHA runner.
Pointer files and source working files are not rewritten by preparation.

## Generated documents

Declare one or more recipes under a collection:

```toml
[[collections.generators]]
name = "api"
path = "docs/api"
inputs = ["src/**/*.py", "scripts/render_docs.py", "pyproject.toml"]
command = ["uv", "run", "--no-project", "--python", "3.14", "python", "scripts/render_docs.py", "{output}"]
```

The repository's `render_docs.py` must accept the supplied output-directory
argument. Pin any renderer dependencies explicitly in the command or its declared
inputs. The tool exports only matching regular HEAD input files into a private
temporary tree and runs the argv there with `shell=False`. The single `{output}`
argument becomes a separate temporary output directory. All outputs map beneath
the logical `path`; they need not be committed. Select those paths in `include`,
for example `**/*.md`. Case variants can use `**/*.[mM][dD]`.

Recipes execute trusted repository code. This is not an OS sandbox: review the
command and its committed script/dependencies before enabling it. The child gets
a small platform/PATH/uv-cache environment, not inherited Python paths or
GitHub/Cloudflare/OpenAI publisher credentials. Untracked source files and
undeclared dirty configuration in the original checkout are not exported. Declared
inputs must match HEAD before and after execution; the exported inputs must also
remain unchanged. The existing package's generator API can be called with
`python -c` when its CLI does not accept an output directory.

Recipes are limited to eight per collection, with disjoint normalized output
prefixes. Empty output, symlinks, nested Git repositories, tracked-path collisions,
input mutations and output changes during ingestion fail explicitly. Generated
files already present in the source working tree are never adopted. A later
successful generation can remove stale documents through the normal publication
and owned-cleanup flow.

## Identity and rollout

Both sources carry optional `origin` metadata in the manifest and MCP response.
LFS records the committed object OID/size; generation records the recipe name and
recipe/input hashes. `source_commit` identifies the pointer or committed inputs,
not a nonexistent generated-file blob. The byte SHA always describes the exact
uploaded document. Unchanged bytes/processing/origin kind reuse existing uploads
and their original provenance, even if current inputs produce the same text.
Preparation identity is checked separately during rescans.

Upgrade the gate to advertise `file-origin-v1` before using these sources. Clients
require this capability before any derived provider mutation, including removal
of a previously published derived file. Keep a compatible gate while publications
contain origin metadata; an older strict reader cannot consume this extension.

Run `plan`, inspect the complete corpus, then run the normal asynchronous `sync`.
Generation and file transfer happen in GHA; OpenAI indexing and final publication
remain background work. Wait for `job.status: complete`, check MCP provenance for
one ordinary, LFS/PDF and generated document, and verify a subsequent no-op.
