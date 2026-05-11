# Getting started (developers)

**Audience:** you cloned the repo and want a running stack on your
laptop in 15 minutes, then to start making code changes with
confidence. If you only need to *deploy* it, jump to
[02-setup.md](./02-setup.md) which covers Docker, env vars, and
operational concerns.

## What you'll have at the end

- Postgres + Redis running in Docker.
- The backend API on `:3000` + an in-process worker.
- The frontend on `:5173` with hot-reload.
- An admin user you can sign in as.
- The unit test suite passing.
- An understanding of which folder maps to which moving part.

Time: ~15 minutes if Docker is already installed.

---

## Prerequisites

| Tool           | Version  | Why |
|----------------|----------|-----|
| Node.js        | ≥ 20     | ESM, native `--test`, `--experimental-test-module-mocks`. |
| Docker         | any recent | Postgres + Redis (you can use a local install instead, but Docker is shorter). |
| npm            | bundled  | Workspaces are not used; each subfolder has its own `package.json`. |
| psql (optional)| 14+      | Handy for poking at the DB; everything works without it. |

A working `git`. A modern browser. That's the whole list.

---

## 1. Clone + bring up Postgres and Redis

```bash
git clone <your-fork-or-this-repo>.git daisy-dag
cd daisy-dag
docker compose up -d postgres redis
```

That's it for the stateful side. The base `docker-compose.yml` ships
Postgres 16 and Redis 7 with sensible defaults and persistent volumes.
The connection strings the backend uses (`postgres://dag:dag@localhost:5432/dag_engine`
and `redis://localhost:6379`) match these defaults out of the box.

If you already have Postgres/Redis running locally, set
`DATABASE_URL` and `REDIS_URL` in `backend/.env` and skip the
`docker compose` call.

---

## 2. Backend

```bash
cd backend
cp .env.example .env          # only essentials are set; tweak later
npm install
npm run migrate               # applies every SQL file in backend/migrations/
npm run create-admin          # interactive — pick an email + password
npm run dev                   # API + in-process worker on :3000
```

`npm run dev` uses `node --watch` so source edits reload the process.
In production you'd run `npm start` for the API and a separate
`npm run worker` per worker instance.

### What `create-admin` does

Creates one local user with the `admin` role + the default workspace
membership. Use those credentials to sign in below. You can rerun it
to add more admins.

### Optional env vars to know about

The defaults work without any of these set:

| Var                   | Effect                                                                                  |
|-----------------------|-----------------------------------------------------------------------------------------|
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | Enables the AI assistant (Prompt tab), `agent` plugin, *Diagnose this failure*, and the plugin generator. |
| `CONFIG_SECRET`       | KEK seed for Configurations encryption. Dev fallback is used if unset (don't ship that). |
| `FILE_ROOT`           | Sandbox path for file/CSV/Excel plugins. Recommended for any shared box.                |
| `PLUGIN_CATALOG_URL`  | Remote marketplace catalog URL. Falls back to `deploy/plugin-catalog.example.json`.    |

Full list is in `backend/.env.example` with comments.

---

## 3. Frontend

```bash
cd frontend
npm install
npm run dev                   # http://localhost:5173 (Vite, hot-reload)
```

Vite proxies `/api` and `/ws` to the backend on `:3000`. Sign in with
the admin you just created.

You should land on the Home page with three tables: **Workflows**,
**Triggers**, **Configurations**. Click **+ New flow** to confirm the
canvas works.

---

## 4. Run a sample workflow

```bash
ls backend/samples/
# batch.json    email-notification.json   hello-world.json
# parallel-with-retry.json   sql-pipeline.json    csv-to-excel.json
# web-scrape.json   spec-form.json
```

In the UI: toolbar **Import** (upload icon) → pick `hello-world.json`
→ **Save** → **Run**. The execution opens in the Instance Viewer
with each node coloured by status.

If that works, your local stack is good.

---

## 5. Run the tests

```bash
cd backend
npm test                      # node --test --experimental-test-module-mocks test/*.test.js
```

The suite covers the engine, plugins, retention, audit, rate limits,
auth, KMS rotation, the plugin transport, the marketplace catalog,
and the plugin generator agent. Most tests use mocked Postgres + a
mocked `fetch`, so no external services are required.

The frontend has no automated tests today; manual smoke is "open
each page and click around."

---

## 6. Code layout

```
backend/
  src/
    api/           Express route modules (graphs, executions, plugins,
                   configs, triggers, ai, audit, users, workspaces, …)
    engine/        DAG executor: parser, scheduler, limits, batch, retry
    plugins/
      builtin/     Built-in action plugins (log, http.request, sql.*, …)
      agent/       Plugin generator agent (LLM → plugin scaffold)
      registry.js  In-process + HTTP-transport dispatcher
      install.js   /manifest + checksum verification + DB upsert
      catalog.js   Marketplace catalog loader
      healthcheck.js  Background /readyz poller for HTTP plugins
    triggers/      schedule / webhook / email / mqtt drivers
    configs/       Typed config types + KMS envelope crypto
    auth/          Local + OIDC, roles, refresh-token rotation
    audit/         Append-only audit log + helper
    retention/     Daily prune of old executions + refresh tokens
    health/        Bounded DB + Redis probes
    middleware/    auth, rateLimit, errors, …
    selfheal/      LLM failure-diagnosis
    db/            pool.js, migrate.js
    cli/           Standalone scripts (createAdmin, retention, installPlugin)
    server.js      Express bootstrap
    worker.js      BullMQ worker bootstrap
  migrations/      Numbered .sql files, applied in order
  samples/         Importable workflow JSON
  test/            node:test suites

frontend/
  src/
    pages/         Top-level routed pages (HomePage, FlowDesigner,
                   PluginsPage, ConfigDesigner, …)
    components/    Shared UI (NodePalette, PropertyPanel, AppTable, …)
    api/           Axios client (one export per resource)
    stores/        Plain reactive stores (auth, etc.)
    routes.js      vue-router config
    main.js        Quasar + Vue Flow bootstrap

plugin-sdk/        @daisy-dag/plugin-sdk — author-facing wrapper for
                   HTTP-transport plugins. ~25 lines of plugin code +
                   a manifest is enough.

plugins-external/  Example HTTP-transport plugins (reddit). Same
                   docker-compose context as the rest of the stack.

deploy/            Edge configs (nginx, Caddy), sample plugin catalog
observability/     Grafana + Tempo + Loki + Prometheus compose overlay
docker/            Container definitions for backend, frontend, worker
wiki/              ← you are here
```

The layout is "feature in one folder where possible." When you want
to add a plugin, you touch `backend/src/plugins/builtin/`. When you
want to add an API endpoint, you touch `backend/src/api/`. Things
that cross-cut (auth, rate limits) live in `middleware/`.

---

## 7. Making your first change

### Add a new built-in plugin

1. Drop a file under `backend/src/plugins/builtin/`:

   ```js
   // backend/src/plugins/builtin/example.js
   export default {
     name: "example.greet",
     description: "Returns 'Hello, <name>!'",
     primaryOutput: "message",
     inputSchema: {
       type: "object",
       required: ["name"],
       properties: { name: { type: "string", title: "Name" } },
     },
     outputSchema: {
       type: "object",
       properties: { message: { type: "string" } },
     },
     async execute(input /*, ctx */) {
       return { message: `Hello, ${input.name}!` };
     },
   };
   ```

2. Restart `npm run dev`. The worker logs `plugin loaded: example.greet`.

3. Refresh the frontend. The new plugin appears in the canvas
   palette and in `GET /plugins`.

That's the loop. No registration step, no DB migration, no config.

### Add a SQL migration

1. Create the next numbered file: `backend/migrations/020_my_thing.sql`.
2. Run `npm run migrate`. The runner records it in
   `schema_migrations` and won't re-apply.

Migrations are append-only — never edit a committed migration.

### Add a frontend page

1. Create `frontend/src/pages/MyPage.vue`.
2. Register in `frontend/src/routes.js` with `meta.roles` if you want
   admin-only.
3. Add a menu entry in `App.vue` (user menu or sidebar).

---

## 8. Common day-to-day commands

```bash
# Backend
cd backend
npm run dev                       # API + worker on :3000 with watch
npm run migrate                   # applies pending migrations
npm test                          # run all unit tests
npm test -- test/specific.test.js # one test file
npm run retention                 # run a retention pass on demand
npm run install-plugin -- --endpoint http://reddit-plugin:8080

# Frontend
cd frontend
npm run dev                       # vite dev server
npm run build                     # production bundle into dist/

# Database
docker compose exec postgres psql -U dag -d dag_engine     # repl
docker compose exec postgres pg_dump -U dag dag_engine > dump.sql
docker compose down -v             # NUKE the volume (start over)

# Logs
docker compose logs -f postgres
tail -f backend/logs/node-events.log
```

---

## 9. What to read next

- **Code orientation, deeper** — [Overview](./01-overview.md).
- **Authoring a workflow** — [DSL reference](./03-dsl-reference.md).
- **Adding a plugin in a non-Node language** — [Plugin architecture](./16-plugin-architecture.md).
- **Operating a real deployment** — [02-setup.md](./02-setup.md) +
  the `ops/` group in the wiki index (auth, rate limiting, alerting,
  backups, retention, TLS).
- **Why we picked these tools** — [Design choices](./00-design-choices.md).

---

## 10. Troubleshooting

The catch-all list lives in [02-setup.md](./02-setup.md#troubleshooting).
The two most common dev hiccups:

- **`ECONNREFUSED` on `npm run migrate`** — Postgres container isn't
  up yet. `docker compose up -d postgres` and wait two seconds.
- **`AI button doesn't appear`** — neither `ANTHROPIC_API_KEY` nor
  `OPENAI_API_KEY` is set. The UI hides AI features when
  `GET /ai/status` reports `configured: false`.
- **`401 from /api/*` after sign-in** — the access token is short-lived
  (15min) and the refresh cookie is httpOnly. Hard-refresh the page to
  trigger `/auth/refresh`; if that doesn't help, sign out and in again.
