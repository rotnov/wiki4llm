# Source provenance

wiki4llm consolidates two previously local components owned by this project:

| Component     | Imported source revision                   | Location        |
| ------------- | ------------------------------------------ | --------------- |
| wiki-rag CLI  | `7cfa445f6395703ade20a63ccb6ad73ff3ba9c97` | Repository root |
| wiki-rag-gate | `63e6f3e15a590cc77f30f6bd47629cbf75ac4b33` | `gate/`         |

The original Python command and gate runtime names are preserved. Importing these
snapshots does not move any deployed namespace, credentials or index state.
The original CLI MIT copyright notice is retained in the root license, which
covers the authored monorepo code. Dependency licenses remain with their packages.

Historical implementation plans and machine-specific execution receipts were not
imported into the public repository. They are not runtime dependencies. Private
corpora, operator files, local databases, model caches and secrets are excluded.
The original local repositories and their histories are retained separately.

Both components are now reviewed and versioned in one Git history. Follow
[development and verification](development.md) for reproducible checks rather
than treating historical local test output as current qualification.
