# Wiki RAG Gate

This subtree owns the workspace-aware MCP gateway for published OpenAI Retrieval manifests, with QMD compatibility. Develop and test locally.
Deployments, changes to existing remote QMD services and permission expansion require an explicit user request.

- Write behavior tests first and observe their expected failures before implementation.
- Treat workspace authorization as a data boundary on every read path, including discovery and errors.
- Never log or commit credentials, document bodies or production corpora.
- Do not weaken checks or tests to hide a failure.
- Keep code and tracked documentation in English.
- Document externally visible contracts and limitations with the implementation.
- Pin QMD integration assumptions and verify them against the installed package.
- Do not claim shared model memory from container count or object identity alone.

- The optional Cloudflare runtime is documented in `docs/cloudflare.md`. Preserve the native-free Worker bundle boundary and run `test:worker`, `check:worker`, and `check:bundle` for Worker changes. Hosted OAuth and deployment require separately authorized acceptance.
