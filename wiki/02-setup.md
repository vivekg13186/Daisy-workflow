# Setup & deployment

**Audience:** devops folk standing up a real deployment. If you're
trying it on a laptop, read [Getting started](./00-getting-started.md)
first — it covers the dev path with much less ceremony.

This page covers the operational shape: Docker profiles, env vars,
migrations, and a brief troubleshooting list.

## Prerequisites

- Node.js ≥ 20 (production images are `node:22-alpine`)
- Docker + docker compose
- PostgreSQL 14+ and Redis 7+ (the bundled images are fine; managed
  services work just as well — point `DATABASE_URL` / `REDIS_URL` at
  them)

## Compose profiles

The root `docker-compose.yml` has two profiles:

- **default** — just Postgres + Redis. You run the backend/frontend
  somewhere else (locally, k8s, your platform of choice).
- **`full`** — also builds and runs the backend + frontend as
  containers. Useful for a single-host deployment or a
  reproducible test environment.

Additional overlays you compose on top:

| File                              | Purpose |
|-----------------------------------|---------|
| `docker-compose.plugins.yml`      | Brings up external HTTP-transport plugins (e.g. the example `reddit-plugin`). Context is the repo root so `plugin-sdk/` is reachable during the build. |
| `docker-compose.backup.yml`       | `pg-backup` cron container that runs `backup.sh` on a schedule. See [Backups](./09-backups.md). |
| `docker-compose.tls.yml`          | Edge container (Caddy or nginx) terminating TLS. See [TLS edge](./14-tls-edge.md). |
| `observability/docker-compose.yml`| Grafana + Tempo + Loki + Prometheus with pre-provisioned dashboards and the five default alert rules. See [Alerting](./12-alerting.md). |

### Just Postgres + Redis (dev-stack-only)

```bash
docker compose up -d
```

### Full stack in containers

```bash
docker compose --profile full up -d --build
```

That brings up `dag_postgres`, `dag_redis`, `dag_backend` (port 3000),
`dag_frontend` (port 5173 → nginx). Pair with the overlays you need.

### With external plugins

```bash
docker compose -f docker-compose.yml \
               -f docker-compose.plugins.yml \
               --profile full up -d --build
```

Then point Daisy at the plugin endpoint (Plugins page → Install from
URL → `http://reddit-plugin:8080`).

## Env vars

Everything is read from `backend/.env` (or the container's env block).
The full list is in `backend/.env.example`; below is the operational
short list.

| Var                                | Default                                 | What it does |
|------------------------------------|-----------------------------------------|--------------|
| `DATABASE_URL`                     | `postgres://dag:dag@localhost:5432/dag_engine` | Postgres connection string. |
| `REDIS_URL`                        | `redis://localhost:6379`                | Redis for BullMQ + WS fan-out + rate-limit store. |
| `PORT`                             | `3000`                                  | API port. |
| `WORKER_CONCURRENCY`               | `4`                                     | Per-process concurrent executions. |
| `CONFIG_SECRET`                    | _(dev fallback)_                        | KEK seed for Configurations encryption — **set this in prod**. |
| `JWT_SECRET`                       | _(dev fallback)_                        | Access-token signing secret. |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | _(unset)_                          | Enables AI features (assistant, agent plugin, diagnose, plugin generator). |
| `AI_MODEL` / `AI_BASE_URL` / `AI_PROVIDER` | provider defaults              | Override model + base URL. |
| `FILE_ROOT`                        | _(unset)_                               | Sandbox path for file/CSV/Excel plugins. Recommended in any shared deployment. |
| `OIDC_*`                           | _(unset)_                               | OIDC config block — see [Auth](./06-auth.md). |
| `WORKFLOW_TIMEOUT_MS` / `NODE_TIMEOUT_MS` | layered defaults                | See [Execution limits](./07-execution-limits.md). |
| `RETENTION_*`                      | sane defaults                            | See [Retention](./08-retention.md). |
| `PLUGIN_HEALTHCHECK_*`             | 60s / 3s / 3                            | See [Plugin architecture](./16-plugin-architecture.md). |
| `PLUGIN_CATALOG_URL` / `PLUGIN_CATALOG_FILE` | _(file fallback)_           | Marketplace catalog source. |

For dev-machine quickstart use, see
[Getting started](./00-getting-started.md). For TLS, alert routing,
KMS providers, and similar concerns, the dedicated ops pages have the
details.

## Migrations

```bash
docker compose exec backend npm run migrate
```

If you're running the backend on the host and Postgres in Docker,
`cd backend && npm run migrate` picks up the same `DATABASE_URL`.

Migrations are append-only numbered SQL files under
`backend/migrations/`. The runner records applied IDs in the
`schema_migrations` table and won't re-apply. Never edit a committed
migration — write the next one.

## Bootstrapping an admin user

```bash
docker compose exec backend npm run create-admin
# or, locally:
cd backend && npm run create-admin
```

Interactive prompt for email + password. Creates the user with role
`admin` and membership of the default workspace. Rerun for additional
admins.

## Building the frontend separately

The compose `full` profile builds the frontend image for you. If you
want a static bundle to serve from your existing edge:

```bash
cd frontend && npm install && npm run build
# produces frontend/dist/  — point your edge at it,
# proxy /api and /ws to the backend.
```

The frontend Dockerfile is a two-stage build (Node 22 to compile,
nginx 1.27 to serve `dist/`). The container exposes port 80 mapped to
host 5173. There's no built-in API proxy in the prod nginx config —
front both with a reverse proxy (see [TLS edge](./14-tls-edge.md)) or
pass the API URL via build args.

## Stopping things

```bash
docker compose down       # leaves volumes intact
docker compose down -v    # wipes the Postgres volume — careful
```

## Troubleshooting

- **`npm run migrate` fails with `ECONNREFUSED`** — Postgres isn't up
  yet. `docker compose up -d postgres` and wait a couple of seconds.
- **AI button doesn't appear in the UI** — the frontend hides it when
  `GET /ai/status` reports `configured: false`. Visit
  `http://localhost:3000/ai/status` to see what the backend received
  (it shows a masked key preview and any warnings).
- **`401 from Anthropic / OpenAI` despite a set key** — see the
  `warnings` field of `/ai/status`. Common causes: trailing whitespace
  in `.env`, wrong key prefix (`sk-` vs `sk-ant-`), copy-paste
  truncation.
- **`email.send` / `mqtt.publish` / `sql.*` errors with
  `config "<name>" not found`** — the named configuration doesn't
  exist yet, or has a different name than what's referenced in the
  node. Open Home → Configurations and verify the row.
- **`agent` plugin: `no agent titled "<title>"`** — the `agent` input
  is case-sensitive and matches the agent's **Title** verbatim. Open
  Home → Agents to check.
- **`agent` plugin: `config "<name>" has no apiKey set`** — the linked
  `ai.provider` configuration is incomplete. Fill it in from Home →
  Configurations.
- **File plugins refuse a path** — `FILE_ROOT` is set; the path tries
  to escape. Keep paths inside the root or unset `FILE_ROOT` for
  unrestricted access (only acceptable in local dev).
- **Graph view shows nodes as "pending" forever** — Dev Tools →
  Network: confirm `GET /executions/:id` returns a `context.nodes`
  object. If it doesn't, the worker hasn't finished yet.
- **`CONFIG_SECRET dev-fallback` warning at startup** — production
  deployments must set `CONFIG_SECRET` to a long random string.
  Without it, secrets are encrypted with a built-in fallback key,
  which is portable but obviously not secret.
- **Plugin healthcheck flips healthy plugins to `degraded`** — increase
  `PLUGIN_HEALTHCHECK_TIMEOUT_MS` (default 3000) if the plugin's
  `/readyz` is sometimes slow. Set `PLUGIN_HEALTHCHECK_INTERVAL_MS=0`
  to disable polling entirely.
