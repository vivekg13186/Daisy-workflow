# Overview

DAG Engine is a workflow runner. You describe a Directed Acyclic Graph of tasks in YAML — each task is an "action" backed by a plugin — and the engine executes them in dependency order, parallelizing whatever can run at the same time.

## What you can do with it

- Wire HTTP calls, SQL queries, file/CSV/Excel I/O, web scraping, and email sends together into a single pipeline.
- Pass data between steps with `${...}` expressions.
- Retry transient failures, skip nodes by condition, fan a workflow out across an array of inputs.
- Save versioned workflows in Postgres, run them on demand, see live execution status in the browser.
- Get help authoring workflows from a built-in AI assistant that knows your installed plugins.

## How the pieces fit together

```
                ┌─────────────────────────────┐
                │       Vue 3 + Quasar        │
                │  • Flow / execution lists   │
                │  • YAML editor (CodeMirror) │
                │  • Graph view (Vue Flow)    │
                │  • Ask-AI dialog            │
                └─────────────┬───────────────┘
                              │ REST + WS
                ┌─────────────▼───────────────┐
                │      Express API server     │
                │  /graphs   /executions      │
                │  /plugins  /ai              │
                │  /ws        (live updates)  │
                └────┬───────────────────┬────┘
                     │ enqueue           │ persist
              ┌──────▼──────┐     ┌──────▼──────┐
              │   BullMQ    │     │  PostgreSQL │
              │   (Redis)   │     │   graphs    │
              └──────┬──────┘     │ executions  │
                     │            └─────────────┘
              ┌──────▼──────┐
              │   Worker    │  ── pluggable actions ──┐
              │  ┌────────┐ │                         │
              │  │ Engine │ │  log / delay / http /   │
              │  └────────┘ │  web / sql / email /    │
              └─────────────┘  file / csv / excel ... │
                                                      │
                                  Append-only JSONL → backend/logs/node-events.log
```

## Components

**Backend** — Node.js (ESM), Express API, BullMQ + Redis worker queue, PostgreSQL for graphs and execution rows. Plugins auto-load from `backend/src/plugins/builtin/`.

**Frontend** — Vue 3 + Quasar (dark mode by default). CodeMirror YAML editor with schema/plugin/node-name autocomplete. Vue Flow for the DAG view with auto-layout via dagre.

**Engine** — pure-JS DAG executor: topological layered scheduler, parallel `Promise.all` per layer, per-node retries with delay, `executeIf` skipping, `batchOver` fan-out, `onError: continue|terminate`.

**AI assistant** — optional. With `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` set, the **Ask AI** button in the UI opens a chat that knows the live plugin list, can answer DSL questions, and generates ready-to-paste workflow snippets.

## Data model

| Table | Purpose |
|-------|---------|
| `graphs` | Versioned workflow definitions (YAML + parsed JSON) |
| `executions` | One row per run: status, timestamps, original `inputs`, final `context` |

Per-node lifecycle history is appended to `backend/logs/node-events.log` as JSON lines (one event per line, each tagged with `executionId` / `graphId`). The execution row's `context.nodes` always carries the post-run summary the UI needs.

## Where to start

- **Just want to try it?** → [Setup](./02-setup.md), then open the UI and pick one of the sample flows in `backend/samples/`.
- **Writing your own workflow?** → [DSL reference](./03-dsl-reference.md).
- **Looking for the right plugin?** → [Plugin reference](./04-plugins.md).
