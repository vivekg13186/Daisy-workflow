Daisy is a workflow automation platform built around a visual editor and a typed DSL. The runtime executes directed acyclic graphs (DAGs) of plugin actions, supports parallel execution with retries and batch fan-out, evaluates FEEL expressions in user-supplied placeholders, and protects credentials with KMS envelope encryption. The platform exposes both in-process and HTTP-transport plugins, supports OIDC authentication, and emits audit, observability, and rate-limit signals suitable for production deployments.

This wiki documents the platform as it ships today. The sidebar organizes pages by audience: introductory material, developer references, the plugin and trigger catalog, and operations.

## Introduction

| Page | Description |
|------|-------------|
| [Getting Started](Getting-Started) | Local development environment, prerequisites, first workflow run. |
| [Overview](Overview) | Architecture, execution model, data model, scaling characteristics. |

## Developer reference

| Page | Description |
|------|-------------|
| [DSL Reference](DSL-Reference) | Workflow JSON schema, FEEL expressions, runtime context, execution semantics. |
| [Plugin Reference](Plugins) | Catalog of built-in action plugins with inputs, outputs, and examples. |
| [Plugin Architecture](Plugin-architecture) | In-process and HTTP-transport plugin contracts, manifests, marketplace catalog. |
| [Execution Limits](Execution-Limits) | Per-node and per-workflow timeouts, retry clamp, batch and token budgets. |
| [Self Healing](Self-Healing) | On-demand failure diagnosis for executions. |

## Operations

| Page | Description |
|------|-------------|
| [Setup](Setup) | Docker compose layout, environment variables, deployment profiles. |
| [Auth](Auth) | Local accounts, OIDC, role-based access control, workspaces, token rotation. |
| [Configs Encryption](Configs-Encryption) | KMS envelope encryption, providers, key rotation, audit trail. |
| [TLS Edge](TLS-Edge) | Reverse proxy configuration for production HTTPS. |
| [Rate Limiting](Rate-Limiting) | Per-IP, per-user, and per-email request budgets backed by Redis. |
| [Health Probes](Health-Probes) | Liveness and readiness endpoints for API and worker. |
| [Retention](Retention) | Scheduled prune of executions, refresh tokens, and history. |
| [Backups](Backups) | Postgres dump and restore procedures. |
| [Alerting](Alerting) | Default Grafana alert rules and notifier routing. |
| [Audit Logging](Audit-Logging) | Append-only log of security-relevant actions. |

## Reference

| Page | Description |
|------|-------------|
| [Screenshots](Screenshots) | User-interface walkthrough. |

Plugin reference pages are listed individually in the sidebar under **Built-in plugins**; trigger drivers are listed under **Triggers**.
