# Daisy-workflow Observability Stack

Drop-in **Grafana + Tempo** with a starter dashboard for Daisy-workflow.
Trace pipeline (workflow.run → node.execute → plugin.\<name\> → external
calls) lands in Tempo; aggregate dashboards (success rate, latency,
token cost) read straight from the engine's Postgres tables — no
metrics export needed.

## Quick start

1. **Bring up the stack:**

   ```bash
   docker compose -f observability/docker-compose.yml up -d
   ```

   Three containers boot:
   - `daisy-tempo` — trace store, OTLP receivers on `:4318` (HTTP) and `:4317` (gRPC).
   - `daisy-grafana` — UI on http://localhost:3001 (anonymous admin).

2. **Point Daisy at Tempo.** Add to `backend/.env`:

   ```bash
   OTEL_SERVICE_NAME=daisy-dag
   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
   ```

   Restart the API and worker.

3. **Run any workflow.** Open Grafana → **Dashboards → Daisy-workflow → Daisy-workflow Overview**.

   You'll see executions per minute, success rate, p50/p95/p99 latency,
   top failing nodes, recent failures (with one-click link into Tempo),
   and token usage by node.

4. **Per-trace debugging.** Grafana → **Explore → Tempo** →

   ```
   { service.name = "daisy-dag" }
   ```

   …picks any recent run. Click into one to see the full tree from HTTP
   request → workflow.run → node.execute children → plugin.\<name\>
   spans → outbound HTTP / pg / Redis calls.

## What's in this folder

| File | Purpose |
|------|---------|
| `docker-compose.yml` | Two-container stack: Tempo + Grafana |
| `tempo.yaml` | Tempo's local-storage + OTLP receiver config |
| `grafana-datasources.yml` | Provisions the Tempo + Postgres datasources on Grafana boot |
| `grafana-dashboards.yml` | Tells Grafana to auto-import any JSON in `dashboards/` |
| `dashboards/daisy-overview.json` | Starter dashboard — five panels covering the basics |

## How the data flows

```
┌──────────────┐      OTLP/HTTP :4318      ┌──────────────┐
│  Daisy API   │──────────────────────────▶│              │
│  + worker    │       (traces only)       │    Tempo     │
└──────┬───────┘                           └──────┬───────┘
       │                                          │
       │                                          │ HTTP :3200
       ▼                                          ▼
┌──────────────┐                           ┌──────────────┐
│  Postgres    │◀──────────────────────────│   Grafana    │
│  (executions │  pg datasource (host)     │              │
│   node_states│                           │  Dashboards  │
│   …)         │                           │  + Explore   │
└──────────────┘                           └──────────────┘
```

- **Traces** come from the OTel SDK in the app. Auto-instrumentations
  (pg, ioredis, undici, http, express) capture cross-cutting concerns;
  the engine's own `workflow.run` / `node.execute` / `plugin.<name>`
  spans (in `backend/src/worker.js`, `executor.js`, `plugins/registry.js`)
  capture business semantics.
- **Aggregate metrics** are not exported — Grafana queries Postgres
  directly via the provisioned datasource. The dashboard's panels are
  plain SQL against `executions` and `node_states`. No Prometheus
  required.
- **trace ↔ db cross-link.** The worker stamps the `workflow.run`
  trace_id onto `executions.context._otel.trace_id` at end-of-run. The
  dashboard's "Recent failed executions" table renders that field as a
  clickable link straight into the Tempo Explore view for that trace.

## Postgres reachability

Grafana is in a container; Postgres is on the host (started by the
repo's main compose, or natively). The `extra_hosts: host-gateway`
mapping in `docker-compose.yml` makes `host.docker.internal:5432` work
on Linux, macOS, and Windows.

### Credentials

The Postgres datasource defaults to the bundled `docker-compose.yml`'s
creds (`dag` / `dag` / `dag_engine`). If you're running native
Postgres with OS-user auth (Postgres.app, Homebrew, etc.) and you see
`FATAL: role "dag" does not exist` in the Grafana logs, edit
`observability/grafana-datasources.yml` and change the three lines
under the `Postgres` datasource:

```yaml
    user: vivek           # your mac/linux username
    secureJsonData:
      password:           # blank for trust/peer auth
    jsonData:
      database: dag_engine
```

Then restart Grafana:

```bash
docker compose -f observability/docker-compose.yml restart grafana
```

You can also tweak it live in **Grafana UI → Connections → Data
sources → Postgres → Save & test** without touching the YAML —
useful for quick experimentation, but the next provisioning reload
will overwrite it.

## Production notes

- **OTel Collector**. For prod, put an OTel Collector between Daisy and
  Tempo. Daisy keeps pointing at `http://collector:4318`; the collector
  fans out to Tempo + (optionally) Loki / Prometheus / Grafana Cloud.
  Adds batching, retry, sampling, redaction. Roughly 30 lines of
  collector config.
- **Tempo retention**. The shipped `tempo.yaml` doesn't pin retention —
  Tempo's defaults apply (currently ~14 days of blocks before
  compaction GCs them, version-dependent). To pin it, paste a
  `compactor.compaction.block_retention` block from the Tempo docs
  matching your image version. For >7 days at scale, switch the
  `storage.trace.backend` from `local` to `s3` / `gcs`.
- **Tempo authn**. The included Tempo has no auth — it's local-only.
  Public deployment goes behind an auth proxy (nginx + basic auth, or
  Grafana Cloud's hosted Tempo).
- **Logs (Loki)**. This stack omits Loki. Daisy's logger already adds
  `trace_id` + `span_id` to every JSON line, so when you do add Loki
  you get free correlation. ~50 lines of compose + a Promtail config.
- **Dashboard JSON**. `dashboards/daisy-overview.json` is meant to be
  forked. Edit in Grafana, export, drop the new JSON in `dashboards/`,
  reload.

## Tearing down

```bash
docker compose -f observability/docker-compose.yml down

# Plus volumes if you want a clean slate:
docker compose -f observability/docker-compose.yml down -v
```
