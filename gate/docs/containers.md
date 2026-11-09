# Docker Compose operation

The standalone `wiki-rag-gate` Compose definition runs on Docker Desktop and on a Linux host. The image contains the gate, pinned QMD dependency, SQLite native modules and inference runtime. Model weights live outside the image, under the persistent state directory. These commands deploy the native Node/QMD runtime, not the Cloudflare Worker.

## Build and bootstrap

Run from the `gate/` directory. Use the host operator's UID/GID so private bind-mounted files remain accessible to the non-root container user. Keep these non-secret variables in the deployment shell or its service configuration for every Compose invocation.

```sh
export WIKI_RAG_GATE_UID=$(id -u)
export WIKI_RAG_GATE_GID=$(id -g)
mkdir -p data sources/team-a sources/team-b
chmod 700 data
docker compose build
```

The following setup qualifies the QMD compatibility backend. For the primary local OpenAI workflow, use the [manifest import and credential instructions](openai-backend.md); any future container deployment must explicitly pass its named query credential to the service.

Copy the selected Markdown/MDX source trees into `sources/team-a` and `sources/team-b`, or set `WIKI_RAG_GATE_SOURCE_DIR` to an existing parent directory. Container-side collection paths must begin with `/sources/`; paths outside that mount are not accessible.

```sh
docker compose run --rm wiki-rag-gate workspace --state /data --id team-a --source docs=/sources/team-a
docker compose run --rm wiki-rag-gate workspace --state /data --id team-b --source docs=/sources/team-b
docker compose run --rm wiki-rag-gate principal --state /data --id owner --allow '*'
docker compose run --rm wiki-rag-gate principal --state /data --id team-a-reader --allow 'team-a,team-a-*'
docker compose run --rm wiki-rag-gate index --state /data
docker compose run --rm wiki-rag-gate token --state /data --principal owner --name local-agent --out /data/owner-token.json
docker compose up -d --wait
```

The last command serves `http://127.0.0.1:8787/mcp`. Configure the client's bearer header from the private credential file; do not paste its value into command-line arguments or logs. Token creation refuses to overwrite an existing file. Operator commands do not publish service ports. An owner token grants data access, not CLI administration.

The default profile uses CPU (`QMD_LLAMA_GPU=off`), suitable for lexical checks without models. Add `--embed` to the index command to build vectors; vector/hybrid queries can download further models on their first request. First-time downloads may exceed a request deadline. Prewarm and qualify inference before relying on latency-sensitive traffic.

## Storage, updates, and restart

`WIKI_RAG_GATE_DATA_DIR` defaults to `./data`. It holds the policy database, credential files, index generations, source snapshots and model cache. `WIKI_RAG_GATE_SOURCE_DIR` defaults to `./sources` and mounts read-only. Both directories must exist before starting Compose; Docker will not silently create root-owned directories. Neither directory enters the Docker build context or Git.

A container restart or recreation preserves these folders. Removing the folders destroys data; Compose does not back them up. Stop the service before making a consistent backup of the entire state directory. Copying live SQLite files without their WAL is not a backup procedure.

Indexing and serving use the same exclusive lease:

```sh
docker compose stop wiki-rag-gate
docker compose run --rm wiki-rag-gate index --state /data --id team-a --embed
docker compose up -d --wait
```

Do not use `compose exec ... index` on a serving instance. Principal edits and token revocation may run concurrently with serving and take effect on subsequent policy checks. Reindexing publishes a fresh generation, so clients must query again for fresh references. If a process was forcibly killed, inspect `/data/.process-lock/owner.json`; verify no container or process uses this state before removing a stale lease manually. Graceful SIGTERM retains the application signal handlers until cleanup completes, including after native inference has loaded signal hooks. Docker has a 150-second graceful-stop window; stuck native inference may still require operator recovery.

## Network and future Cloudflare routing

Inside the container the listener binds `0.0.0.0`; the host-published port binds **only `127.0.0.1`**. Authentication, Origin rejection and the exact Host allowlist still apply. Changing bind address does not disable them.

- `WIKI_RAG_GATE_PORT`: host port, default `8787`.
- `WIKI_RAG_GATE_AUTHORITY`: additional exact accepted HTTP authority, default `127.0.0.1:{WIKI_RAG_GATE_PORT}` (8787 when unset).
- Internal `127.0.0.1:8787` remains accepted for the health probe.

For a host-running tunnel, route its origin to `http://127.0.0.1:{WIKI_RAG_GATE_PORT}` and either preserve an explicitly allowed public Host or configure the tunnel's HTTP Host override to an allowed authority. A tunnel in another container needs an explicitly designed shared network and allowed internal Host. This configuration does not create a tunnel, OAuth server or public route; gate bearer credentials remain required.

The healthcheck requires an unauthenticated request to receive 401. This verifies the listener/authentication boundary, not index readiness or model inference. Run a real authenticated query to qualify those paths.

## Optional NVIDIA profile

The base image manifest supports Linux amd64 and arm64. Build natively on the deployment host with the same Dockerfile and lockfile. Local arm64 validation does not prove the amd64 CUDA driver/runtime path.

Before enabling GPU access, verify the chosen device and NVIDIA Container Toolkit on the deployment host. A host with a failed GPU can cause NVIDIA container initialization to fail even when another device is selected. The profile deliberately does not reproduce device-file or library-mount workarounds automatically.

```sh
export WIKI_RAG_GATE_GPU_ID=1  # Example only: choose a verified healthy device.
docker compose -f compose.yaml -f compose.gpu.yaml config --quiet
docker compose -f compose.yaml -f compose.gpu.yaml build
docker compose -f compose.yaml -f compose.gpu.yaml up -d --wait
```

Use the same two `-f` arguments for GPU indexing/operator commands. The override requests the selected NVIDIA device and sets `QMD_LLAMA_GPU=cuda`. QMD can fall back to CPU on initialization failure; a healthy HTTP endpoint alone does not prove GPU usage. Qualify actual embedding/query execution, backend selection and VRAM on the target host before calling the deployment GPU-ready.

Keep existing host services and data intact during a future rollout: use a new checkout/state directory and an unused loopback port, qualify it independently, and switch routes only after acceptance. This deployment is a separate operation.

## Reproducible local test

```sh
npm ci
npm run check
npm test
docker compose build
npm run test:compose
```

The smoke test uses a unique Compose project, temporary synthetic source/state folders and a free loopback port, without overriding the derived Host authority. It verifies real QMD MCP query/get, cross-workspace denial, the serve/index lease, persistent references and credentials after forced container recreation, and live token revocation. It removes only its own containers/network and temporary folders afterward. It never uses production data or requires a remote host.
