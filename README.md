# Daisy  — Wiki

A low code workflow automation application. Visual editor, pluggable actions,
parallel execution, retries, batch fan-out, FEEL expressions, KMS
envelope encryption, OIDC, audit logging, AI-assisted authoring, and
out-of-process plugins.

 

---

## Start here

| Page                                              | What it covers |
|---------------------------------------------------|----------------|
| [Getting started (developers)](./00-getting-started.md) | Local dev quickstart, code layout, common commands, your first plugin. |
| [Overview](./01-overview.md)                      | Component diagram, execution algorithm, data model, scaling. |

---

## For developers

You're authoring workflows, writing plugins, or working on the engine
itself.

| Page                                              | What it covers |
|---------------------------------------------------|----------------|
| [DSL reference](./03-dsl-reference.md)            | Full JSON syntax, FEEL expressions, runtime context, execution semantics. |
| [Plugin reference](./04-plugins.md)               | Every built-in action plugin with inputs, outputs, examples. |
| [Plugin architecture](./16-plugin-architecture.md)| In-process vs HTTP-transport, the SDK, manifests, marketplace catalog, the plugin generator agent. |
| [Execution limits](./07-execution-limits.md)      | Per-node + per-workflow timeouts, retry cap, token budget. |
| [Self-healing](./15-self-healing.md)              | Diagnose-on-demand for failed nodes. |

Reference for individual plugins lives under [`plugins/`](./plugins/);
trigger drivers under [`triggers/`](./triggers/).

---

## For devops

You're deploying, securing, scaling, or operating it.

| Page                                              | What it covers |
|---------------------------------------------------|----------------|
| [Setup](./02-setup.md)                            | Docker layouts, env vars, compose profiles. |
| [Auth & authorization](./06-auth.md)              | Local accounts, OIDC, roles, multi-workspace, token rotation. |
| [Configs encryption](./05-configs-encryption.md)  | KMS envelope encryption, providers, rotation, audit. |
| [TLS edge](./14-tls-edge.md)                      | nginx / Caddy / k8s ingress for production HTTPS. |
| [Rate limiting](./11-rate-limiting.md)            | Per-IP, per-user, per-email budgets backed by Redis. |
| [Health probes](./10-health-probes.md)            | `/healthz` + `/readyz` on API + worker, k8s + compose examples. |
| [Retention](./08-retention.md)                    | Daily Postgres prune for executions, refresh tokens, history. |
| [Backups](./09-backups.md)                        | `pg_dump`, restore scripts, compose overlay, deployment-shape runbook. |
| [Alerting](./12-alerting.md)                      | 5 default Grafana rules + Slack/PagerDuty/email routing. |
| [Audit logging](./13-audit-logging.md)            | Who-did-what-when on security-relevant actions. |

---

## Quick links


- Backend code: [`backend/src/`](../backend/src/)
- Frontend code: [`frontend/src/`](../frontend/src/)
- Plugin SDK: [`plugin-sdk/`](../plugin-sdk/)
- Example external plugin: [`plugins-external/reddit/`](../plugins-external/devvit.reddit/)
- Migrations: [`backend/migrations/`](../backend/migrations/)
- Observability stack: [`observability/`](../observability/)

---

> Daisy-DAG is developed with AI assistance. Bug reports and feedback
> are welcome via the repo's issue tracker.
