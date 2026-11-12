# Connect Wiki RAG to Codex Cloud

This procedure was exercised end to end on 2026-11-11: a published private Codex
Cloud environment used an explicitly selected account-level Wiki RAG plugin to
list workspaces, inspect status, search and retrieve a document. It did not use a
local Mac MCP connection or copied OAuth credentials. Recheck current UI labels
and account/workspace policies when repeating the procedure.

Read the skill's access reference for the gate's reader mapping and Managed OAuth
requirements. Obtain the intended MCP origin, Access app/issuer and permitted
workspace from the installation inventory. The URLs and identifiers below must
come from that installation; do not reuse another operator's callback or plugin ID.

## 1. Create or reuse the cloud plugin

1. Sign in to [ChatGPT Plugins](https://chatgpt.com/plugins) with the same account
   and workspace intended for Codex Cloud. Desktop login does not imply the browser
   is signed in. Inspect installed plugins first and reuse a matching connection.
2. For a new connection, select **+ / Add → Add custom MCP server**. Set the name
   to **Wiki RAG**, a read-only project-documentation description, the full HTTPS
   endpoint ending in `/mcp`, and **OAuth** authentication.
3. Expand **Advanced OAuth settings** and wait for discovery. Verify the actual
   authorization/token/registration URLs, issuer and resource against the intended
   Access app. Use **Dynamic Client Registration (DCR)** when advertised.
4. Obtain ChatGPT's exact callback. In the verified UI, temporarily selecting
   **User-Defined OAuth Client** revealed a generated **Callback URL**; copy that
   address, then restore **DCR**. This does not require creating manual credentials.
   If the UI changes, use its current documented callback-discovery method.
5. Read the Access app's current `oauth_configuration`. Add only that exact callback
   to `dynamic_client_registration.allowed_uris`, retaining existing callbacks and
   other settings. Read back the result. Do not switch the IdP, rename an Access
   team or enable wildcard redirects to make a new client register.
6. Review the custom-server warning and select **Create as a plugin**, then
   **Connect**. Complete the configured Access login and the ChatGPT client consent.
   An existing Access session may skip the email-code entry; that is still OAuth.
7. Verify the plugin under **Manage / Settings → Plugins**: an account must appear
   under **Connected accounts**. Use **Refresh tools**, then inspect the plugin's
   app/tool details. Expect six read-only tools: `list_workspaces`, `status`,
   `query`, `find_documents`, `get`, `multi_get`. Preserve existing tool approval settings.

If creation reports rejected settings before login, check discovery and the exact
callback allowlist. If a network error appears after creation, inspect installed
plugins before retrying. In the exercised flow, the plugin had been saved despite
the error; continuing **Connect** on that plugin succeeded without a duplicate.

## 2. Prepare the chosen cloud environment

Ask which environment only if the user's choice cannot be recovered from the
request or existing context. Do not create or publish unrelated environments.

1. Open **Settings → Codex Cloud → Environments**. For the chosen environment use
   **Continue setup** if unpublished, or **Edit** for an existing published setup.
2. Verify selected repository/ref, sharing, startup instructions, network policy
   and secret names. Check repository access, shell/Git readiness, checkout path,
   HEAD and dirty state. A branch name alone does not establish freshness.
3. Prepare only what the user's task requires. MCP acceptance does not require a
   native product build, reindexing, submodule bootstrap or new provider keys.
   Keep test-only restrictions in the test prompt; do not turn the environment's
   permanent Start skill into a prohibition on future legitimate development.
4. If shell diagnostics need egress, allow the exact gate and OAuth issuer hosts
   rather than enabling unrestricted Internet access. These rules permit network
   access; they neither attach a cloud plugin nor provide its OAuth session.
   The hosted plugin path may run outside the task shell's network boundary.
5. Review and save draft changes, then **Publish / Save and publish**. Retain the
   intended sharing scope. Wait for publication confirmation: a saved draft is not
   runnable. Where available, `list_cloud_environments` must report `runnable: true`
   for the selected configuration. A `ready` status alone is insufficient.

Do not add Mac keychain exports, local OAuth files, publisher/admin service tokens
or OpenAI keys to the environment to replace the existing cloud reader connection.
Missing tools in the setup conversation are not proof they are unavailable in a
normal task; in the exercised setup they were absent there and present in the new
task with an explicit plugin selection.

## 3. Start a fresh task and explicitly select the plugin

The user must authorize a new cloud test task. Reuse an existing designated test
when appropriate. A supported thread-creation tool can use the selected runnable
environment ID; do not substitute a local task with the same repository name.

The verified web route is:

1. Open **Codex**, choose **Work in → Cloud**, then select the published environment
   by name. Confirm the selection before sending anything.
2. Type `@Wiki` in the composer and select the actual **Wiki RAG** plugin from the
   suggestions. Verify the plugin chip/link is present. Merely writing its name or
   describing the endpoint is not proof the plugin is attached.
3. Append a bounded read-only acceptance prompt and send it. Wait for a real task
   ID rather than treating a temporary `client-new-thread` URL as a running task.

Example prompt; replace the workspace and search topic with approved values:

```text
Verify Wiki RAG from this Codex Cloud task. Confirm the cloud execution environment
and checkout path without editing files. Use the attached Wiki RAG plugin:
list_workspaces(limit=20, offset=0), status for the intended workspace, then
query(mode="hybrid", limit=3) for its setup documentation. Use get(fromLine=1,
maxLines=20) with one exact ref returned by query. Report successful calls,
document counts, repository/path/source revision and one supported fact. Do not
dump full documents or secrets. Do not run indexing, deployments, builds, commits
or pushes. If tools or authorization are unavailable, report the exact blocker;
an HTTP request is not a substitute for this MCP test.
```

If an automated create call stalls, reconcile the task list/UI before any retry;
it may have created a task without returning a receipt. Stopping local waiting
does not prove server-side cancellation. Resume any matching task. Use the web
route only after checking for an existing result, and check for a late duplicate
before starting additional work. Do not claim that a hanging tool is a gate error.

## 4. Verify actual cloud execution and tool output

Inspect the test's execution trace, not only its final prose. In the verified web
UI, expand **Worked for … → Used Wiki RAG integration**, then individual tool
results. Check `status` counts and `get` provenance against the expected workspace
and publication. Confirm that `get` used a reference returned by the search.
Use small valid limits; `list_workspaces(limit=100)` is rejected by the gate schema.

Do not infer local execution from a ChatGPT `/local/{task-id}` URL: the verified
cloud task used that UI route. Establish execution from the selected cloud
environment, task runtime and checkout evidence. Conversely, that URL alone is
not proof of cloud execution either.

Record the environment, task link, plugin identity, actual calls and nonsecret
provenance in the protected operator receipt. A successful four-tool test proves
that connection and retrieval path; it does not prove `multi_get`, restricted-user
isolation, refresh expiry or native project builds unless separately exercised.
Never publish a private corpus, raw credentials or installation inventory with
this public skill. Report missing steps honestly instead of substituting a local
Desktop/CLI test or a connected badge for cloud acceptance.

## Primary documentation

- [Create and connect a custom MCP plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [Cloud environment setup and publication](https://learn.chatgpt.com/docs/environments/cloud-environments)
- [Cloud plugins versus local MCP configuration](https://learn.chatgpt.com/docs/extend/mcp)
- [Cloudflare Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
