# Published manifest contract, schema version 1

In local mode, `{state}/manifest.json` is the only exported publication. It contains no API
credentials, local roots, unpublished operations, or obsolete files. The
private `state.json` journal is not a gate interface. All configured collections
are committed together by one atomic filesystem replacement; readers see the
old or new complete document. File creation and remote search visibility are
not part of that atomic transaction.

Remote mode uses this same manifest schema, with non-null committed provenance,
but the provisioned gateway authority owns the publication. The active gate
manifest, ingestion active-operation set, generation and command receipt commit
in one Durable Object transaction. There is no authoritative local manifest file
or separate manual import step. Read-only clients retrieve generation-pinned
chunks and verify their exact byte digest. See [remote-state operation](remote-state.md).

## Fields

| Field            | Type and meaning                                                |
| ---------------- | --------------------------------------------------------------- |
| `schema_version` | Integer, exactly `1`                                            |
| `project_id`     | OpenAI Project identifier                                       |
| `publication_id` | UUID identifying this immutable published snapshot              |
| `generation`     | Monotonic integer within this durable state authority           |
| `published_at`   | UTC ISO 8601 timestamp; null for generation zero                |
| `collections`    | Map from stable configured collection name to collection object |

Each collection object has these fields:

| Field               | Type and meaning                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `repository`        | Stable repository identity; not a local path                                                                        |
| `branch`            | Configured branch binding, or null                                                                                  |
| `vector_store_id`   | Provider vector store identifier                                                                                    |
| `repository_commit` | HEAD inspected during the source scan, or null for an unborn repository                                             |
| `processing`        | `{preprocessing: "per-file-v1", chunking: {type: "static", static: {max_chunk_size_tokens, chunk_overlap_tokens}}}` |
| `files`             | Map from normalized case-sensitive relative POSIX path to file object                                               |

Each file object has these fields:

| Field             | Type and meaning                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| `path`            | Original repository path, equal to the map key                                                       |
| `file_id`         | Provider File ID; the vector-store attachment shares this ID                                         |
| `vector_store_id` | Equal to the collection's store ID                                                                   |
| `sha256`          | Lowercase SHA-256 of the exact uploaded bytes                                                        |
| `version`         | SHA-256 of canonical JSON `[sha256, file_processing]`                                                |
| `kind`            | Lowercase original extension without dot                                                             |
| `source_commit`   | Commit whose blob matches the exact uploaded bytes; null for working-tree content without that proof |
| `preprocessing`   | `utf8-text-v1` (unchanged UTF-8 bytes) or `pdf-native-v1` (unchanged native PDF bytes)               |
| `operation_id`    | Opaque ownership/reconciliation identifier; not a permission token                                   |

`file_processing` is the collection processing object with its `preprocessing`
field replaced by the individual file value. Text is uploaded as `.txt`; PDF
files retain `.pdf` and `application/pdf`. Native PDF text extraction belongs
to the provider, and the byte hash always describes the uploaded PDF itself.

Canonical JSON for hashes uses Python-compatible `json.dumps(..., sort_keys=True,
separators=(",", ":"))` with default ASCII escaping, UTF-8 encoded. Consumers should
use the supplied version value; they need not recreate operation IDs. A file's
provenance remains its original upload provenance when an unchanged upload is
reused at a later HEAD. Thus `repository_commit` and `source_commit` can differ.

Retirement and terminal-ingestion retry transitions remain private journal state;
they do not change this exported schema. An attempt whose deletion has begun is
never republished. Confirmed failed/cancelled ingestion preserves the prior manifest
while a bounded new attempt is prepared on a later run.

Generation zero contains an empty collection map and no active IDs. A no-op
update preserves generation, timestamp and publication ID. Changed content,
selection, processing or recorded repository HEAD yields a new publication.

## Consumer rules

1. Authenticate the caller and resolve its allowed project/collections using
   the gate's own trusted configuration. The manifest itself grants no rights.
2. Read and validate the whole JSON document before importing anything. Fail
   closed for missing/malformed/unsupported versions, duplicate or mismatched
   identities, or unsupported paths. Do not normalize distinct paths into aliases.
3. Import atomically, bound to the expected project and collection/store mapping.
   Reject lower generations for the same state authority. An identical generation
   must have the same publication ID/content. Reprovisioning with a new state
   authority requires an explicit operator binding change.
4. Accept search results only when `(project_id, collection name, vector_store_id,
file_id)` appears in the imported snapshot. Filter before assembling contexts,
   reranking with an LLM, returning snippets, or generating an answer.
5. A `get` request must resolve an authorized logical path to that snapshot's active
   file ID. Never accept arbitrary caller-supplied provider IDs as authorization.
6. Cache by publication ID and recheck the active snapshot for subsequent reads.
   Treat cached content from retired IDs as unavailable. Provider deletions can
   remain visible briefly; staged files can appear before any publication.

The Python helpers `wiki_rag.read_manifest(path)` and
`wiki_rag.is_active(manifest, project_id, collection_name, vector_store_id, file_id)`
provide structural reading and the active-ID predicate. A gate must additionally
apply its own full import validation, authorization and anti-replay policy.

No canonical text cache is exported. Upload bytes are exact source bytes (UTF-8 text or native PDF),
but a provider's parsed-content endpoint may alter presentation. If using
`GET /vector_stores/{store}/files/{file}/content` for get, follow pagination and
define line numbers over the concatenated returned text; do not claim those line
numbers are original Git source lines without a separate source mapping.
