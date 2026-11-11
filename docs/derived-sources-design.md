# Verified LFS and generated documentation

## Requested behavior

Index selected Markdown/PDF sources and explicitly generated documentation in
the existing workspace alongside source code. Generated files remain outside Git.
Keep asynchronous batch submission and background publication; no CI polling.

## Source contracts

- Ordinary tracked files retain literal-HEAD, clean-index, no-symlink, secret,
  format, budget and rescan checks. No generic allow-untracked switch exists.
- A collection can opt into `lfs = true`. For a canonical HEAD LFS pointer, accept
  content only when SHA-256 and byte length match the pointer. Materialized bytes
  and cached LFS objects are verified identically. Validate pointer byte/count
  budgets before network transfer. In GHA invoke git-lfs's own smudge command on
  each exact pointer, with fixed GitHub generic/origin LFS URLs, basic transfers
  only, no remote autodetection and URL-scoped checkout credentials. Do not invoke
  repository smudge filters, honor endpoint overrides or fetch model weights.
- A collection can declare named generators with normalized virtual `path`, an
  argv `command` containing one `{output}` argument, and tracked `inputs` globs.
  Export only the declared literal HEAD inputs into a private temporary input tree.
  Execute trusted committed recipes there without a shell or inherited Python path,
  checkout credentials or publisher/provider secrets, with a separate private
  temporary output directory. This is
  trusted repository code execution, not a sandbox for adversarial programs.
- Before/after generation, verify declared inputs against HEAD; capture their
  digest and the recipe digest. Enumerate only regular supported outputs with
  no symlinks, nested repositories, secret paths or collisions with tracked paths
  or other generators. Apply normal include/exclude, format and byte/count budgets.
  Rescans verify the same input and output inventories/bytes using a separate
  preparation identity, even if an upload version is reused; never index arbitrary
  preexisting gitignored documents or mutate the source checkout to stage artifacts.
- A consumer can call its generator's Python API with the temporary output argument
  when the existing CLI has no output option. Pin renderer dependencies and the
  interpreter, and export the renderer script, source inputs, rendering configuration
  and lockfile.

## Provenance and compatibility

Add optional `origin` to source files, private operations, published entries and
MCP source metadata. Existing records without origin remain ordinary Git blobs.

- LFS: `{kind: "git-lfs", oid: sha256, size: bytes}`.
- Generated: `{kind: "generated", recipe: name, recipe_sha256: hash,
inputs_sha256: hash}`.

For derived files, `source_commit` identifies the committed pointer or generation
inputs. `path` for generated files is logical and need not exist as a Git blob.
The exact uploaded-byte SHA remains unchanged in meaning. File versions include
the origin kind plus existing content/processing identity; unchanged uploads keep
their original operation provenance rather than relabeling it on a later run.
Publication validates origin against immutable operation receipts. Provider
attributes and background readiness checks include `source_kind` when present.
Extend prospective manifest bounds and background expected attributes as well as
schemas. Advertise `file-origin-v1` and require it before any derived provider
mutation, including cleanup of existing derived records. Deploy
the compatible gate before publishing the consumer-capable CLI.

## Test and rollout plan

1. Add failing selection tests for LFS hash/size tampering, missing objects,
   symlinks, targeted fetch and unchanged ordinary-file enforcement.
2. Add failing generator tests for input mutation, ignored-file non-adoption,
   output collisions/substitution, removed outputs, no-op byte reuse and sanitized
   child environment. Verify a real documentation generator in an isolated run.
3. Extend strict manifest/journal validation and MCP provenance with Python and
   real-workerd tests, including mixed legacy/derived async publication and retry.
4. Update reusable GHA preparation and public operator docs; run affected tests,
   full qualification and independent review. No public installation-specific data.
5. Prepare consumer TOML masks and pinned generator recipe, preserve source-code
   selection and the empty-marker exclusion. Preview the complete corpus, then
   follow the authorized PR/rollout process with plan, batch submission,
   background completion, no-op and Markdown/PDF/generated-document retrieval.
