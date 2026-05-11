# DAISY Engine — Wiki

A JSON-defined DAG workflow engine with a drag-and-drop visual editor, pluggable actions, parallel execution, retries, batch fan-out, FEEL expressions, and an AI assistant.

## Contents

1. [Overview](./01-overview.md) — what the app does and how the pieces fit together.
2. [Setup](./02-setup.md) — local dev and Docker deployment.
3. [DSL reference](./03-dsl-reference.md) — full JSON syntax, FEEL expressions, runtime context, and execution semantics.
4. [Plugin reference](./04-plugins.md) — every built-in action plugin with inputs, outputs, and examples.
5. [Configs encryption](./05-configs-encryption.md) — KMS envelope encryption, providers, rotation, audit.
6. [Auth & authorization](./06-auth.md) — local accounts, OIDC, roles, multi-workspace, token rotation.
7. [Execution limits](./07-execution-limits.md) — wall-clock timeouts, retry cap, layered defaults.
8. [Retention](./08-retention.md) — daily Postgres prune for executions, refresh tokens, history.
9. [Backups](./09-backups.md) — pg_dump + restore scripts, docker overlay, runbook for 3 deployment shapes.
10. [Health probes](./10-health-probes.md) — `/healthz` + `/readyz` on API + worker, k8s + compose examples.
11. [Rate limiting](./11-rate-limiting.md) — per-IP, per-user, per-email budgets backed by Redis.

## Quick links

- Sample workflows: [`backend/samples/`](../backend/samples/)
- Backend code: [`backend/src/`](../backend/src/)
- Frontend code: [`frontend/src/`](../frontend/src/)
- Architecture diagram: [`ARCHITECTURE.md`](./ARCHITECTURE.md)

 

> [!NOTE]
> This application is developed with the support of AI agents.
