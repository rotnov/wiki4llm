# wiki4llm

This repository owns the Python `wiki-rag` ingestion CLI, reusable GitHub workflow,
and the TypeScript MCP gate under `gate/`. The recommended hosted setup is OpenAI
Retrieval with Cloudflare Workers, a SQLite Durable Object and Access Managed OAuth.

- Keep tracked code, comments and documentation in English.
- Never commit credentials, private project corpora, operator state or local run logs.
- Preserve workspace authorization, immutable ownership and durable ingestion intents.
- Use Python 3.14 with uv for the CLI and Node 24 or newer with the pinned npm lockfile
  for the gate. Do not weaken checks or add suppressions to hide failures.
- Write behavior tests before changing runtime behavior. For relocation or docs-only
  changes, run the checks relevant to the affected paths without duplicating tests.
- Read `docs/development.md` for verification and `docs/deployment.md` for deployment.
  Gate-specific contracts remain under `gate/docs/`; do not duplicate protocol schemas.
- For Wiki RAG deployment, access, OAuth clients, ingestion or recovery tasks, read
  `.claude/skills/wiki-rag-ops/SKILL.md` and its task-specific references. This is
  the canonical operator skill for both Claude and Codex. Codex agents load it
  through this instruction; no duplicate skill or tracked symlink is required.
- Publishing source does not authorize deploying a Worker, uploading project data or
  enabling a consumer workflow. Those actions require the user's task to include them.
- Existing Worker names, namespaces, issuer/audience bindings and stored credentials
  are operational resources. Repository renaming must not silently replace them.
