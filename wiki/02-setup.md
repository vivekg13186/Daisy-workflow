# Setup

Two paths: **local dev** (good for tinkering, fast reloads) or **Docker** (single command, isolated).

## Prerequisites

- Node.js 20 or newer
- Docker + docker compose (only for the Docker path; or if you want Postgres + Redis as containers while the rest runs locally)
- A modern browser

## Local development

### 1. Bring up Postgres and Redis

These are the only persistent dependencies. The repo ships a compose file that exposes them on the standard ports.

```bash
docker compose up -d postgres redis
```

(If you have your own Postgres / Redis already, point the env vars at them and skip this.)

### 2. Backend

```bash
cd backend
cp .env.example .env
# edit .env if needed — the defaults match the docker compose
npm install
npm run migrate     # applies SQL migrations (graphs, executions, inputs column)
npm run dev         # starts the API on :3000 + spins up an in-process worker
```

`npm run dev` runs the API server **and** an in-process BullMQ worker, so a single process handles HTTP, WebSocket, and execution. In production you'd typically run `npm start` for the API and `npm run worker` separately, scaled horizontally.

### 3. Frontend

```bash
cd frontend
npm install
npm run dev         # http://localhost:5173 (proxies /api and /ws to :3000)
```

### 4. Configure optional features

These all live in `backend/.env` — restart the backend after any change.

| Feature | Required env vars |
|---------|------------------|
| AI assistant ("Ask AI" button) | `ANTHROPIC_API_KEY` *or* `OPENAI_API_KEY`, optional `AI_MODEL` / `AI_BASE_URL` / `AI_PROVIDER` |
| Email plugin | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` (or `SMTP_HOST=json` for dry-run) |
| File / CSV / Excel sandbox | `FILE_ROOT=/path/to/sandbox` (recommended in any shared deployment) |

The full list of variables is documented in `backend/.env.example`.

### 5. Try it out

Open `http://localhost:5173`, click **+ New** to create an empty flow, or open one of the samples:

```bash
# Anything in backend/samples/ can be pasted into the editor:
ls backend/samples/
# → batch.yaml              email-notification.yaml  parallel-with-retry.yaml  spec-form.yaml
#   csv-to-excel.yaml       hello-world.yaml         sql-pipeline.yaml         web-scrape.yaml
```

Click **Validate**, then **Save**, then **Run** (the dialog lets you pass a JSON input). The execution opens as its own tab with the graph view colored by per-node status.

### Stopping things

```bash
docker compose down       # leaves volumes intact
docker compose down -v    # also wipes the Postgres volume
```

---

## Docker

The compose file has two profiles:

- **default profile** — just Postgres + Redis. You run the backend / frontend locally against them.
- **`full` profile** — also builds and runs the backend + frontend as containers.

### Just Postgres + Redis (recommended for development)

```bash
docker compose up -d
```

### Full stack in containers

```bash
docker compose --profile full up -d --build
```

That brings up four containers: `dag_postgres`, `dag_redis`, `dag_backend` (port 3000), `dag_frontend` (port 5173 → nginx).

To pass env vars (AI keys, SMTP creds, FILE_ROOT, etc.) to the backend container, either:

- Add them under the `backend` service's `environment:` block in `docker-compose.yml`, or
- Create a `.env` file at the repo root (compose auto-loads it) and reference vars with `${VAR_NAME}` in the compose file.

### Running migrations against a containerized DB

```bash
docker compose exec backend npm run migrate
```

If you're running the backend locally but Postgres in Docker, just `cd backend && npm run migrate` from the host — it picks up the same `DATABASE_URL`.

### Building the frontend image

```bash
cd frontend && npm install && npm run build      # produces dist/
# or use the compose 'full' profile which does this for you
```

The frontend Dockerfile is a two-stage build: Node 20 to compile, nginx 1.27 to serve `dist/`. The container exposes port 80 and is mapped to host 5173 by compose. There's no built-in API proxy in the prod nginx config — for production you'd typically front both with a reverse proxy or set the API URL via build args.

---

## Troubleshooting

- **`npm run migrate` fails with ECONNREFUSED** — Postgres isn't up yet. `docker compose up -d postgres` and wait ~2 s, or check `docker compose logs postgres`.
- **AI button doesn't appear in the UI** — the frontend hides it when `GET /ai/status` reports `configured: false`. Visit `http://localhost:3000/ai/status` to see what the backend received (it shows a masked key preview and any warnings).
- **401 from Anthropic / OpenAI despite a set key** — see the warnings field of `/ai/status`. Common causes: trailing whitespace in `.env`, wrong key prefix (`sk-` vs `sk-ant-`), copy-paste truncation.
- **File plugins refuse my path** — `FILE_ROOT` is set; the path tries to escape. Either keep paths inside the root or unset `FILE_ROOT` for unrestricted access (only recommended for local dev).
- **Graph view shows nodes as "pending" forever** — open Dev Tools → Network and confirm `GET /executions/:id` returns a `context.nodes` object. If it doesn't, the worker hasn't finished yet — wait or click the refresh button.
