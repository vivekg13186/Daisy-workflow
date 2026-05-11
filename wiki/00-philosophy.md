# Philosophy

**Audience:** developers and devops folk who want to understand *why*
Daisy-DAG looks the way it does before they read the code.

Daisy-DAG is a workflow engine. It is **not** trying to be Airflow,
Temporal, Argo, or n8n. It picks a small set of opinions and commits
to them. This page is the short version of those opinions so the rest
of the wiki makes sense.

## What the project optimises for

| We say yes to                                              | We say no to                                          |
|------------------------------------------------------------|-------------------------------------------------------|
| A workflow you can read in 60 seconds.                     | A 200-line YAML you need a debugger to understand.    |
| A canvas a non-developer can drive end-to-end.             | Code-only DSLs that gate self-service on PRs.         |
| Failures that surface a *cause*, not a stack trace.        | Workflows that fail silently in a queue.              |
| Plugins as out-of-process containers when they need to be. | Forcing every action into the engine's runtime.       |
| Postgres + Redis. Nothing else stateful.                   | A bespoke metadata store.                             |
| AI as a power tool, not a foundation.                      | A workflow engine that *only* runs when LLMs respond. |

If a feature would force us off this column, we usually don't ship it.

## Five principles the code actually follows

### 1. The workflow is the artefact.

A flow is a single JSON document. The canvas, the YAML/JSON tab, the
DB row, the API payload, and the file under `backend/samples/` are
the same shape. There is no "compiled" representation that drifts.

Implication: every editor, every assistant, every import/export, every
test fixture works with the same object. You can paste a flow into
chat, hand it to a colleague, or `curl` it into a fresh deployment.

### 2. Plugins are the only place new behaviour lives.

The engine itself knows nothing about HTTP, SQL, MQTT, or AI. It
knows about nodes, edges, retries, fan-out, and timeouts. Every
verb (`http.request`, `sql.select`, `email.send`, …) is a plugin
that declares its input/output schema and an `execute(input, ctx)`
function.

Implication: you can grow the engine's vocabulary without modifying
the engine. Two-line plugins are fine; 300-line plugins are also fine.
Anything that needs a different language or a tricky runtime ships as
an HTTP-transport plugin in its own container.

### 3. Secrets never appear in workflows.

Anything sensitive — an API key, a DB password, an SMTP credential —
lives in **Configurations**. Workflows reference them by name; the
engine resolves them into `ctx.config.<name>.<field>` at execute time
and strips them again before persisting the execution row.

Implication: you can copy a flow JSON to a colleague, paste it into
GitHub, or ship it between environments without leaking secrets.
The fact that a flow runs in dev and prod with the same JSON is a
feature, not an accident.

### 4. Make the engine boring; make the operator surface rich.

The execution engine itself is a few hundred lines: topological sort,
parallel `Promise.allSettled` per layer, retries, `executeIf`,
`batchOver`. There is no expression DSL of our own invention — we
embed [FEEL](https://kiegroup.github.io/dmn-feel-handbook/), which is
standardised, well-tested, and has friendly syntax.

The richness lives where operators actually look: the canvas, the
execution viewer, the audit log, the plugin admin page, the
diagnose-this-failure button, the catalog browser, the rate-limit
metrics. Most of the code in the repo is *not* the engine.

### 5. Production-ready by default, not in the next sprint.

Every feature ships with: an env-var contract, a Postgres migration if
it touches schema, a retention policy if it writes rows, a healthcheck
if it owns a connection, a rate limit if it accepts user input, an
audit trail if it changes state, and a page in this wiki.

Implication: this engine isn't a hobby toy with a roadmap of "we'll
add auth later." Auth, KMS envelope encryption, OIDC, backups, TLS,
alerts, audit logs, rate limits, retention, plugin healthchecks — all
of it is here on day one. The trade-off is a slightly bigger
`backend/src/` than a minimum-viable DAG runner. We think that's the
right trade.

## Where AI fits

The product description calls Daisy-DAG "AI-focused" and that's
honest, but it's not what most people mean by that phrase.

We don't believe a workflow engine should depend on an LLM to run.
Every workflow you author can execute with `ANTHROPIC_API_KEY` and
`OPENAI_API_KEY` both unset; only AI-shaped features (`agent` plugin,
the **Ask AI** dialog, the failure-diagnosis button, the plugin
generator agent) require a key.

What we do use AI for:

- **Authoring acceleration** — describe a workflow in English; get
  importable JSON. The assistant knows your installed plugins.
- **Self-healing** — when a node fails, you can click *Diagnose this
  failure* and an LLM reads the workflow, the node config, and the
  error to suggest a likely cause.
- **Plugin generation** — describe a plugin in English on the
  Plugins page; the agent emits a complete HTTP-transport scaffold
  (manifest, code, Dockerfile, README, deploy steps) ready to
  download and deploy.
- **Agents as plugin nodes** — the `agent` plugin lets workflows
  call named LLM personas (system prompt + provider config) without
  the workflow author having to wire any of the LLM plumbing.

In every case AI is a **suggestion machine** that drops back to plain
text/JSON the operator reviews. There is no "AI execution mode."
There is no auto-install. There is no auto-deploy. The human stays
in the loop for anything that changes infrastructure or money.

## Things we explicitly don't try to do

- **Cluster scheduling and resource quotas.** That's Kubernetes' job.
  Workers are stateless Node processes; scale them with whatever
  scheduler you already use.
- **A new query language.** We bet on FEEL. If you need transformations
  more involved than FEEL handles, write a `transform` plugin in
  TypeScript or run a `web.scrape` / `sql.execute` step and feed it
  back in.
- **A bespoke message bus.** Triggers and queues use Redis (BullMQ).
  If you outgrow Redis, you have bigger problems than this engine.
- **A multi-tenant SaaS shape.** Workspaces give logical separation
  inside a single deployment. We don't aim to be a hosted service.

## When Daisy-DAG is the wrong tool

- You need long-running workflows measured in days with deterministic
  recovery semantics across deploys. (Use Temporal.)
- You need millions of concurrent executions. (Use Argo Workflows or
  a queue you already operate.)
- Your workflows are *only* code, never visual, and they live in a
  monorepo with your application. (Use Inngest, Trigger.dev, or
  hand-rolled job queues.)

If you're past those constraints, the rest of this wiki should feel
useful rather than awkward.

## Where to go next

- **Why this stack, why these algorithms** → [Design choices](./00-design-choices.md).
- **First-time setup with the developer hat on** → [Getting started](./00-getting-started.md).
- **The shape of the engine itself** → [Overview](./01-overview.md).
