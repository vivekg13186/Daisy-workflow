# Plugin architecture — Phases 1, 2, 3

Plugins now live in two places: **in-process** (core + drop-ins
under `plugins-extra/`) and **HTTP-transport** (separate containers
exposing a small four-endpoint contract). Both kinds register in
the same `plugins` DB table; the engine dispatches based on
`transport_kind`.

- **Phase 1** (shipped): DB-backed registry + HTTP transport + one
  example external plugin authored without an SDK.
- **Phase 2** (shipped): `@daisy-dag/plugin-sdk` (drops author
  boilerplate from ~170 to ~25 lines) + admin Plugins page in the
  frontend (install / enable / disable / uninstall / refresh).
- **Phase 3** (shipped): multi-version side-by-side, `name@version`
  action pinning, marketplace catalog browse, checksum-verified
  install, and a background healthcheck poller. See
  [Phase 3 specifics](#phase-3-specifics) below.

The existing in-process plugin path is unchanged.

## The four-endpoint contract

An HTTP-transport plugin is *any process* exposing:

| Method | Path        | Purpose                                       |
|--------|-------------|-----------------------------------------------|
| GET    | `/manifest` | Returns the plugin's manifest JSON.            |
| GET    | `/healthz`  | Liveness — 200 if process is responding.       |
| GET    | `/readyz`   | Readiness — 200 iff dependencies are usable.   |
| POST   | `/execute`  | Runs the plugin with the engine's payload.     |

The plugin's language is irrelevant — Node, Python, Go, Rust, all
work as long as they implement those four routes.

### /execute payload

The core POSTs this JSON:

```json
{
  "input":       { /* the resolved inputs from the workflow */ },
  "executionId": "abc-123",
  "workspaceId": "xyz-456",
  "nodeName":    "fetch_top_posts",
  "config":      { /* configs the plugin declared via configRefs */ },
  "deadlineMs":  60000
}
```

The plugin returns:

```json
{ "output": { /* anything matching the plugin's outputSchema */ } }
```

Or, for back-compat with simpler shapes, just the output object
itself (the core treats a response missing `output` as the output).

## The manifest

Same shape whether the plugin is in-process or remote. In-process
plugins generate it from the module's exports; HTTP plugins ship a
JSON file.

```json
{
  "name":          "reddit.search",
  "version":       "0.1.0",
  "description":   "Search public Reddit posts.",
  "engineMinVersion": "0.2.0",
  "primaryOutput": "posts",
  "inputSchema":   { "type": "object", "required": ["query"], "properties": { ... } },
  "outputSchema":  { "type": "object", "properties": { "posts": { "type": "array" } } },
  "configRefs":    [
    { "name": "reddit", "type": "reddit.oauth", "required": false }
  ],
  "ui": { "category": "social", "icon": "reddit" }
}
```

`configRefs` declares which workspace configurations the plugin
needs. The core resolves them from `ctx.config[ref.name]` and
includes the **plaintext** values in the `/execute` payload —
plugins don't need an auth path back to the core for secrets.

## Boot sequence

```
1. server.js / worker.js
   ↓
2. loadBuiltins()
     scans  src/plugins/builtin/    → source='core',  transport='in-process'
     scans  plugins-extra/          → source='local', transport='in-process'
     UPSERTs each into plugins table
   ↓
3. registry.loadAll()
     SELECT * FROM plugins WHERE enabled = true
     For each row:
       transport='in-process' → re-import module from manifest.__manifest.modulePath
       transport='http'       → register stub with endpoint
   ↓
4. registry.invoke(name, input, ctx, hooks, opts)
     in-process: call p.execute() directly
     http:       POST to {endpoint}/execute with the standardised payload
```

The pre-migration boot path (no plugins table yet) falls back to
in-memory builtins so dev environments still work before running
`npm run migrate`.

## Installing an external plugin

Two paths — both produce the same plugins-table row.

### CLI

```bash
# 1. Make the plugin container reachable from the core.
docker compose -f docker-compose.yml \
               -f docker-compose.plugins.yml \
               --profile full up -d

# 2. Install — fetches /manifest, verifies it, persists.
cd backend
npm run install-plugin -- --endpoint http://reddit-plugin:8080

# 3. Reload the registry so the engine sees the new row without
#    a full restart. (Admin only — see API below.)
curl -X POST http://localhost:3000/plugins/refresh \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### Admin API

```
POST /plugins/install
{
  "endpoint": "http://reddit-plugin:8080",
  "source":   "local"
}
```

Admin only. Returns the row that landed in the table.

Other admin operations on the same path:

| Method | Path                                       | What it does |
|--------|--------------------------------------------|--------------|
| GET    | `/plugins`                                 | List + status (any signed-in user). |
| POST   | `/plugins/install`                         | Install / upgrade an HTTP plugin from its endpoint. |
| POST   | `/plugins/refresh`                         | Reload the in-memory registry from DB. |
| POST   | `/plugins/:name/disable`                   | Temporarily disable. Workflows referencing it fail loudly. |
| POST   | `/plugins/:name/enable`                    | Re-enable. |
| DELETE | `/plugins/:name`                           | Uninstall every version. Refused for `source=core` (disable instead). |
| DELETE | `/plugins/:name/:version`                  | Uninstall one specific version (Phase 3). |
| POST   | `/plugins/:name/:version/set-default`      | Promote a version to the default for unpinned action refs (Phase 3). |
| GET    | `/plugins/catalog?refresh=1`               | Marketplace catalog (Phase 3). |
| POST   | `/plugins/install-from-catalog`            | Checksum-verified install from a catalog entry (Phase 3). |
| POST   | `/plugins/agent/generate`                  | LLM drafts a plugin scaffold from a free-form prompt (Phase 4). |
| POST   | `/plugins/agent/download`                  | Bundles a generated scaffold into an `application/zip` (Phase 4). |

## Authoring an external plugin — with the SDK (Phase 2)

`@daisy-dag/plugin-sdk` lives in `plugin-sdk/` of the repo. It
wires the four endpoints, validates the manifest, threads the
engine's `AbortSignal` and `deadlineMs`, handles graceful
shutdown, and produces JSON log lines on stdout — leaving the
plugin author to write only `execute()`.

```js
// plugins-external/myplugin/index.js
import { servePlugin } from "@daisy-dag/plugin-sdk";
import fs from "node:fs";

const manifest = JSON.parse(
  fs.readFileSync(new URL("./manifest.json", import.meta.url), "utf8"),
);

servePlugin({
  manifest,
  async execute(input, ctx) {
    // ctx = { executionId, workspaceId, nodeName, config, deadlineMs, signal }
    const r = await fetch(`https://api.example.com/${input.q}`, {
      signal: ctx.signal,
    });
    return { result: await r.json() };
  },
  async readyz() {
    // optional — return false to make /readyz respond 503.
    return true;
  },
});
```

That's the whole plugin. ~25 lines. Compare with the pre-SDK
version under the git history of `plugins-external/reddit/`
which was ~170 lines for the same behaviour.

### Packaging

`plugins-external/reddit/package.json` uses the SDK as a local
file dependency:

```json
{
  "dependencies": {
    "@daisy-dag/plugin-sdk": "file:../../plugin-sdk"
  }
}
```

The Dockerfile uses the **repo root** as the build context so the
SDK folder is reachable during `npm install` (the
`file:../../plugin-sdk` reference would otherwise fail with
"path outside build context"):

```dockerfile
FROM node:22-alpine
WORKDIR /workspace

COPY plugin-sdk              /workspace/plugin-sdk
COPY plugins-external/reddit /workspace/plugins-external/reddit

WORKDIR /workspace/plugins-external/reddit
RUN npm install --omit=dev
USER node
CMD ["node", "index.js"]
```

And the compose entry passes context + dockerfile separately:

```yaml
reddit-plugin:
  build:
    context: .
    dockerfile: plugins-external/reddit/Dockerfile
```

Once published to npm (a Phase 3 item), authors will just `npm
install @daisy-dag/plugin-sdk` and forget about the relative path.

## Admin UI (Phase 2)

The `/plugins` page (admin only — UserMenu → **Plugins**) lists
every registered plugin with version, source, transport, status,
and an enabled toggle. Four actions:

| Button / control | What it does |
|------------------|--------------|
| **Install plugin** (toolbar) | Dialog accepts an endpoint URL. POST `/plugins/install` fetches `/manifest`, validates it, persists. |
| **Enabled** toggle | Flips `enabled` flag in DB + reloads the in-memory registry. Disabled plugins disappear from the node palette but stay in the table for re-enable. |
| **Refresh** (toolbar) | Re-reads the plugins table into the engine's in-memory cache. Useful after a direct SQL edit. |
| **Trash icon** (per row, non-core only) | Uninstalls the plugin entirely. Core plugins are protected — the icon shows a lock instead. |

Every action audit-logs under `plugin.install` / `plugin.enable` /
`plugin.disable` / `plugin.uninstall` so the trail of "who
installed what when" is preserved.

The Plugins page is admin-only because the actions all carry
infrastructure consequences (network reach into your container
network, exposure of config plaintexts to third-party code).

## What ctx serialisation means for plugins

In-process plugins see the full live `ctx` object — `ctx.execution`,
`ctx.memory`, `ctx.config`, `ctx.nodes`, etc.

HTTP plugins see a **JSON-only subset**:

- `input` — the resolved inputs (post `${...}` expansion).
- `executionId`, `workspaceId`, `nodeName` — for the plugin to
  log / trace correctly.
- `config` — only the configs the plugin declared via `configRefs`.

Plugins that need access to a richer slice of state (e.g. read
other nodes' outputs) should accept that as explicit `input`
fields — the workflow author wires it via `${nodes.foo.output}`.
Stays explicit, no implicit globals.

## What's still not in scope

- **Streaming over the wire.** The agent's `hooks.stream.text()`
  hook stays in-process-only. HTTP plugins return their final
  output synchronously. A future SSE-style callback URL is on the
  roadmap.
- **Signed manifests (PGP / cosign).** Phase 3 ships
  SHA-256 manifest checksums (catalog declares a `manifestSha256`,
  the server verifies on download). Full code-signing is a
  later phase.
- **Auto-launch containers.** Daisy does not pull or run plugin
  images for you. The operator brings up the container; Daisy
  then probes its endpoint.

## Trust + security

Installing a third-party plugin grants it:

- Network access from inside your docker network (or k8s namespace).
- Plaintext values of every workspace configuration its manifest
  declares via `configRefs`. **Review the manifest before
  installing.**

There is no sandbox. Plugins run as their container's user; the
isolation is whatever Docker / k8s gives you. For multi-tenant
deployments with untrusted plugin authors, run each plugin under
a strict network policy (no egress except to its known
dependencies) and a non-root, no-privileged container.

## File map

| File | Role |
|------|------|
| `backend/migrations/018_plugins.sql` | plugins table (Phase 1) |
| `backend/migrations/019_plugins_versions.sql` | multi-version PK + catalog/checksum metadata (Phase 3) |
| `backend/src/plugins/registry.js`    | DB-backed registry + invoke dispatch + version-aware lookup |
| `backend/src/plugins/install.js`     | fetch /manifest, validate, checksum-verify, persist |
| `backend/src/plugins/catalog.js`     | marketplace catalog loader + 5-minute cache (Phase 3) |
| `backend/src/plugins/healthcheck.js` | background `/readyz` poller (Phase 3) |
| `backend/src/plugins/agent/generate.js` | LLM plugin-generator agent (Phase 4) |
| `backend/src/api/plugins.js`         | admin install/enable/disable/uninstall + catalog + set-default + agent |
| `backend/src/cli/installPlugin.js`   | `npm run install-plugin -- --endpoint URL` |
| `backend/test/plugin-http-transport.test.js` | install + manifest validation tests |
| `backend/test/plugin-phase3.test.js`         | checksum verify + parsePluginRef + catalog loader |
| `backend/test/plugin-agent.test.js`          | agent JSON-parser + validator + path-traversal guard (Phase 4) |
| `plugin-sdk/`                        | `@daisy-dag/plugin-sdk` — servePlugin() + manifest validation |
| `plugin-sdk/README.md`               | author-facing usage docs |
| `plugins-external/reddit/`           | example external plugin (SDK-driven, ~25 lines) |
| `docker-compose.plugins.yml`         | overlay that brings up external plugins |
| `deploy/plugin-catalog.example.json` | sample marketplace catalog (Phase 3 fallback) |
| `frontend/src/pages/PluginsPage.vue` | admin Plugins page (tabs: Installed / Browse marketplace) |

## Phase 3 specifics

### Multi-version side-by-side

A plugin's primary key is now `(name, version)`. Two flavours of
the same plugin can coexist:

```
postgres=# SELECT name, version, is_default, enabled FROM plugins WHERE name='reddit.search';
    name        | version | is_default | enabled
----------------+---------+------------+---------
 reddit.search  | 0.1.0   | f          | t
 reddit.search  | 0.2.0   | t          | t
```

#### `name@version` pinning in the DSL

DAGs reference a plugin by `action` name. Unpinned refs resolve to
the row marked `is_default = true`:

```json
{ "action": "reddit.search", "inputs": { "query": "${vars.q}" } }
```

To freeze a workflow against a specific version, append `@<semver>`:

```json
{ "action": "reddit.search@0.1.0", "inputs": { "query": "${vars.q}" } }
```

The registry exposes a `parsePluginRef(actionId)` helper which
splits the string and returns `{ name, version }`. If the pinned
version doesn't exist the engine throws a clear error at parse
time, not at execute time.

### Marketplace catalog

A catalog is a single JSON document describing installable plugins.
Source order:

1. `PLUGIN_CATALOG_URL` — fetched on demand (5-minute cache, set
   `?refresh=1` on the endpoint to bypass).
2. `PLUGIN_CATALOG_FILE` — local-disk fallback. Defaults to
   `deploy/plugin-catalog.example.json`. Handy for air-gapped
   deployments and CI / tests.

```json
{
  "name":    "Daisy-DAG Official",
  "version": "1",
  "plugins": [
    {
      "name":            "reddit.search",
      "version":         "0.1.0",
      "summary":         "Search public Reddit posts.",
      "category":        "social",
      "tags":            ["reddit", "search"],
      "homepage":        "https://github.com/...",
      "containerImage":  "ghcr.io/.../reddit:0.1.0",
      "containerPort":   8080,
      "manifestUrl":     "https://.../manifest.json",
      "manifestSha256":  "<hex>",
      "catalogEntryUrl": "https://catalog.example.com/#reddit.search@0.1.0"
    }
  ]
}
```

`manifestSha256` is **strongly recommended** in any production
catalog — the install path computes the hash on the raw manifest
body before parsing and rejects on mismatch.

### Install from catalog

```
POST /plugins/install-from-catalog
{
  "catalogEntryUrl": "...",                         // optional, recorded for audit
  "manifestUrl":     "https://.../manifest.json",   // required
  "manifestSha256":  "<hex>",                       // optional but recommended
  "endpoint":        "http://reddit-plugin:8080",   // running container
  "source":          "marketplace"                  // free-form provenance
}
```

The flow:

```
1. GET manifestUrl                  ← body verbatim, no JSON parse
2. crypto.createHash("sha256")(body)
   compare to manifestSha256        ← throws on mismatch
3. JSON.parse(body) + validate manifest
4. GET <endpoint>/readyz            ← initial status
5. INSERT into plugins (...)
   with manifest_sha256, catalog_entry_url, source='marketplace:<url>'
```

### Background healthcheck

`backend/src/plugins/healthcheck.js` starts on worker boot. Every
`PLUGIN_HEALTHCHECK_INTERVAL_MS` (default 60s) it probes
`<endpoint>/readyz` on every `enabled=true` HTTP-transport row.
A 2xx response wipes the failure streak and sets `status='healthy'`.
Otherwise the streak increments; once it hits
`PLUGIN_HEALTHCHECK_DOWN_AFTER` (default 3) consecutive failures the
row flips from `degraded` to `down`. The Plugins page renders
these states with coloured badges and shows the last error.

Relevant env vars:

| Name                                   | Default | Meaning |
|----------------------------------------|---------|---------|
| `PLUGIN_HEALTHCHECK_INTERVAL_MS`       | 60000   | Poll cadence. Set < 5000 to disable. |
| `PLUGIN_HEALTHCHECK_TIMEOUT_MS`        | 3000    | Per-probe abort timeout. |
| `PLUGIN_HEALTHCHECK_DOWN_AFTER`        | 3       | Consecutive failures before status → `down`. |
| `PLUGIN_CATALOG_URL`                   | _unset_ | Remote catalog HTTPS endpoint. |
| `PLUGIN_CATALOG_FILE`                  | `deploy/plugin-catalog.example.json` | Local-disk catalog fallback. |

### Plugin-generator agent ("Ask agent")

The Plugins page exposes an **Ask agent** button on the *Installed* tab.
It runs the user's free-form prompt through the same LLM provider the
rest of the app uses (Anthropic or OpenAI-compatible — see
`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`) and returns a complete
HTTP-transport plugin scaffold:

| File             | Role |
|------------------|------|
| `manifest.json`  | Daisy-DAG plugin manifest (name, version, inputSchema, outputSchema, configRefs). |
| `index.js`       | `servePlugin()` from `@daisy-dag/plugin-sdk` with the generated `execute()` body. |
| `package.json`   | ESM, depends on `@daisy-dag/plugin-sdk` via `file:../../plugin-sdk`. |
| `Dockerfile`     | `node:22-alpine`, copies `plugin-sdk` + plugin folder, runs as `node`. |
| `README.md`      | Brief description + I/O shape + required configs. |

Plus a markdown **Deploy** tab the UI renders inline with build / run /
install commands.

Backend wiring:

```
POST /plugins/agent/generate      (admin) — returns JSON { name, version, files, deployInstructions }
POST /plugins/agent/download      (admin) — returns application/zip
                                            payload: { name, files: [{ path, content }] }
```

The agent does **not** install anything — it just emits files. The
admin reviews the bundle in the dialog (one tab per file, plus the
deploy tab), clicks **Download zip**, unpacks under
`plugins-external/<name>/` in their repo, brings the container up,
then completes the usual `Install from URL` flow on the same page.

Every generation and download lands in the audit log under
`plugin.agent.generate` / `plugin.agent.download` so the trail of
"who asked the agent to draft what" is preserved.

#### Generation contract

The system prompt forces the model to emit a single strict JSON object.
`backend/src/plugins/agent/generate.js` then:

1. Strips any ` ```json ` fences the model might wrap the response in.
2. Slices to the outermost `{...}` block (tolerates trailing prose).
3. Parses + validates the shape: plugin name matches
   `/^[a-z][a-z0-9_.-]*$/`, version is semver, every required file is
   present, paths can't escape the plugin folder (`..`, leading `/`),
   `manifest.json`'s content round-trips as JSON.
4. Surfaces a clear `422` error on any of the above so the UI doesn't
   render garbage.

The download endpoint mirrors the files under
`plugins-external/<name>/<file>` inside the zip so the operator can
unpack straight into their repo root.

### Admin UI

The Plugins page has two tabs:

- **Installed** — same per-row info as Phase 2. When multiple
  versions of the same plugin coexist the row marked default is
  badged `default`; other rows expose a **Set default** action. The
  uninstall icon scopes to the row's `(name, version)` pair when
  the name has multiple versions; otherwise it removes everything
  (matching the legacy single-version behaviour).
- **Browse marketplace** — fetches `/plugins/catalog`, renders each
  entry as a card with summary, tags, and category. The **Install
  snippet** button surfaces a paste-ready `docker-compose.yml`
  service stanza using the entry's `containerImage` /
  `containerPort` so the operator can stand up the container.
  **Install** opens a dialog that asks for the running endpoint URL
  and POSTs to `/plugins/install-from-catalog`. Categories drive a
  filter dropdown; a free-text search matches name, summary, and
  tags.
