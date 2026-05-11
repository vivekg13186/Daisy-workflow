# Design choices

**Audience:** developers and devops folk who are about to read the
code and want to know which decisions are load-bearing and which are
incidental.

Each section is a question we got asked while building, the answer
we settled on, and what we'd want a contributor to know before they
challenge it.

## DSL: JSON, not YAML

We started on YAML; switched to JSON in PR #45.

- A workflow is a serialisable object. JSON round-trips through every
  language and editor without ambiguity. YAML's "norway problem,"
  multi-document parsing, and tag system added surface area we didn't
  need.
- The canvas writes JSON, the API stores JSON, the AI assistant emits
  JSON, the import button accepts JSON. One shape, everywhere.
- For humans-reading-a-blob, we ship a read-only JSON tab in the
  editor and a `transform` node that takes FEEL — which is far more
  readable than nested YAML lookups would be.

**Won't change unless** a customer needs a YAML import path; even then
it would be a converter, not a second internal representation.

## Expression language: FEEL via `feelin`

- We needed an expression language for `${...}` placeholders. Hand-rolling
  one is a year of work for the engine to do badly.
- FEEL is an OMG standard from the DMN spec. It has if/then/else,
  list comprehensions, string ops, date arithmetic, and a friendly
  syntax (no awkward Jinja braces, no `$` sigils inside the
  expression).
- [`feelin`](https://github.com/nikku/feelin) is small, zero-dep, and
  written by the bpmn.io folks.
- We keep a fast path for pure dotted lookups (`${nodes.fetch.output.body.title}`)
  so the common case doesn't pay the parser cost.

**Trade-off:** FEEL is unfamiliar to JS-first developers. We mitigate
by injecting `toJson`, `parseJson`, `toJsonPretty` helpers so the
typical "I just want a JSON blob" cases stay one-line.

## Engine: layered topological sort with `Promise.allSettled`

- DAG executors usually fall into one of: (1) tick-driven schedulers
  (Airflow), (2) actor models (Temporal), (3) layer-by-layer parallel
  evaluators. We picked (3) because it fits a single Node process
  cleanly and parallelism falls out of `Promise.allSettled`.
- The cost is that a layer's slowest node dictates the layer's latency.
  We accept that because real workflows have wide-but-shallow shapes
  and the engine's overhead is dominated by I/O anyway.
- **What we got for free:** retries per node, `executeIf` skipping,
  `batchOver` fan-out, `onError: continue|terminate`, cooperative
  cancellation via `AbortSignal`, and predictable execution semantics
  that are easy to test.

**Won't change unless** a workflow needs single-node back-pressure or
streaming pipelines, in which case a streaming plugin is a better fit
than rewriting the scheduler.

## Database: PostgreSQL with JSONB columns

- One stateful store. No second metadata DB, no S3 for "exec history,"
  no Redis-as-truth.
- JSONB lets us store the canonical workflow blob without splitting
  it into a hundred normalized tables. We use real columns for the
  things we query on (status, timestamps, owner) and JSONB for
  payloads (`dsl`, `parsed`, `context.nodes`).
- Migrations are plain `.sql` files under `backend/migrations/`,
  applied with `npm run migrate`. There's no ORM doing schema-from-models;
  the schema is in version control and looks like Postgres.

**Trade-off:** JSONB queries are slower than typed columns. We add
indices where we hit them (`gin` on `triggers.config`, partial
unique indices on `plugins`, etc.). When we need to *query into* a
JSONB field we either promote it to a real column or accept the cost.

## Queue: BullMQ on Redis

- One queueing library, mature, with priorities, retries, scheduling,
  and a usable dashboard ecosystem.
- Redis is a dependency we'd carry anyway for live execution events
  and rate limits, so the marginal cost is zero.
- Workers are stateless Node processes. Run as many as you want; the
  queue does fair-share dispatch.

**Won't change unless** we need cross-region queueing or
exactly-once semantics. We don't.

## Live updates: WebSocket pub/sub via Redis

- Each API process subscribes to a Redis channel and forwards
  execution events to its connected clients. A worker can update a
  client connected to any API process.
- The token is sent as a query-string param on the WS upgrade (browsers
  can't set `Authorization` headers on `WebSocket`). The backend
  validates the token and refuses cross-workspace subscribers.
- We don't ship SSE on top of this — WS gives us bidirectional
  channels which we'll need for the user-input plugin's resume flow.

## Plugins: in-process *and* HTTP-transport

This is the design call that took the longest to get right.

- **In-process plugins** live in `backend/src/plugins/builtin/`. They
  are ESM modules with `{name, inputSchema, outputSchema, execute(input, ctx)}`.
  The engine calls them directly. No serialisation, full access to
  `ctx` including streams. Cost: their language is Node, their
  failure modes are the worker's failure modes.

- **HTTP-transport plugins** are containers that expose four endpoints
  (`/manifest`, `/healthz`, `/readyz`, `/execute`). The engine
  validates the manifest at install time, then POSTs the standardised
  payload to `/execute` per invocation. Cost: a network hop and a
  JSON-only `ctx` subset. Benefit: any language, any runtime, any
  set of native deps, isolated failures.

- Both live in the same `plugins` Postgres table, distinguished by
  `transport_kind`. The DSL author doesn't know or care which one
  they're using.

**Authoring SDK:** [`@daisy-dag/plugin-sdk`](../plugin-sdk/) wires the
four endpoints so a Node plugin author writes ~25 lines instead of
~170. It threads `AbortSignal` and `deadlineMs`, validates the
manifest, and emits JSON logs.

**Why not WASM / WASI?** Tooling isn't where it needs to be yet for
network/disk-intensive plugins. We'll reconsider in a few releases.

## Frontend: Vue 3 + Quasar, light theme

- Vue's template syntax keeps property-panel components small.
  Composition API + `<script setup>` gives us React-grade ergonomics
  without React's render-loop foot-guns.
- Quasar gives us a *complete* UI kit (tables, dialogs, q-table
  filters, q-tree, layouts) on top of Vue. No more snowflake
  component decisions.
- Light theme by default. The product target is operators who read
  workflows all day; high-contrast dark themes are noisier when the
  canvas is mostly white anyway. Dark theme toggle is on the roadmap.
- The canvas is [Vue Flow](https://vueflow.dev/), an d3-flow port
  to Vue. We tried react-flow + a small React island; the
  cross-framework story wasn't worth the saved keystrokes.

**Trade-off:** smaller plugin community than React's. We've yet to
hit anything we couldn't build cleanly in Vue.

## Configurations: typed, encrypted, named

- The `configs` table is the only acceptable place for secrets.
  Workflows reference them by **name** (`mail.smtp`, `slack.prod`),
  never by inline values.
- Each type has a schema: which fields, which are required, which
  are `secret` (encrypted at rest).
- Encryption is **KMS envelope** — every config row has its own
  data-encryption key (DEK), wrapped by a key-encryption key (KEK)
  that lives in your KMS of choice (local, AWS KMS, others
  pluggable). Rotating the KEK rewraps DEKs without re-encrypting
  every row.

**Why named, not numeric IDs?** A flow that references `mail.smtp` is
self-documenting and survives a re-import in a different environment
as long as that env has a `mail.smtp` configured. IDs would force a
manifest-and-link step that no one wants.

## Auth: local accounts + OIDC, roles + workspaces

- We support both local username/password (bcrypt) and OIDC (Google,
  Okta, anything OpenID-compliant). Same user table, just different
  authentication paths.
- Three roles: `admin`, `editor`, `viewer`. We don't try to model the
  permission matrix of a 1000-engineer org; if you need that you'll
  be plugging into your existing IdP anyway.
- **Workspaces** are logical tenants inside a single deployment. Every
  graph / config / trigger / execution belongs to one workspace.
  Admins can switch; non-admins see only their workspaces.
- Tokens: short-lived access token (15min) + long-lived refresh
  cookie (httpOnly). Standard rotation on /auth/refresh.

**Won't change unless** SSO requirements push us toward SAML.

## Observability: OpenTelemetry traces + Grafana

- Spans emitted at workflow / node / plugin level. Carries
  `executionId`, `graphId`, `workspaceId`. Default exporter is OTLP
  HTTP.
- The compose overlay ships Grafana + Tempo + Loki + Prometheus
  pre-wired with five alert rules (error rate, queue depth, p95
  latency, healthcheck failures, restart loops).
- We do not invent a metrics format. We do not invent a tracing
  format. We emit OpenTelemetry and stop.

## Self-healing: opt-in diagnosis, not auto-remediation

- A failed execution gets a **Diagnose this failure** button. Click
  it → an LLM reads the workflow, the node config (with secrets
  redacted), and the error → returns a structured guess at the
  cause.
- We deliberately do **not** auto-retry-with-changes, auto-redact, or
  auto-edit. The user reviews the diagnosis and decides.

## What we won't do (yet)

| Idea                                | Status                                                                       |
|-------------------------------------|------------------------------------------------------------------------------|
| WASM plugin runtime                 | Watching the WASI roadmap; not a priority.                                  |
| Signed plugin manifests (PGP/sigstore) | Phase 3 ships SHA-256 manifest checksums; full code-signing is later.   |
| Distributed transactions across nodes | Out of scope; build idempotent plugins or use a saga pattern in workflow. |
| A hosted SaaS                       | Not the product.                                                             |
| Visual debugger / breakpoints       | Plausible; not on the next milestone.                                       |

## Where to go next

- **Understanding the engine** → [Overview](./01-overview.md).
- **Coming from scratch?** → [Getting started](./00-getting-started.md).
- **The philosophical version of this page** → [Philosophy](./00-philosophy.md).
