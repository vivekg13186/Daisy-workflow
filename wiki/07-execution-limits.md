# Execution resource limits

How Daisy bounds the cost of a single workflow run. PR 7 lands the
three limits that block real production deployments: per-node
wall-clock timeout, per-workflow wall-clock timeout, and a hard cap
on retry attempts. Iteration caps, token budgets, and concurrent-
execution limits are planned follow-ups.

## The layered model

Every limit has three layers of defaults, with the more specific
layer winning:

```
per-node DSL field     → strongest
per-workflow DSL field
env-var default        → weakest
```

A node without a `timeout` field falls back to the workflow's
`nodeTimeout`. Without that, it falls back to
`EXECUTION_DEFAULT_NODE_TIMEOUT`. Operator can set the env var to an
empty string to disable the default layer entirely (not recommended).

## Env defaults

```bash
EXECUTION_DEFAULT_NODE_TIMEOUT=60s
EXECUTION_DEFAULT_WORKFLOW_TIMEOUT=30m
EXECUTION_MAX_RETRIES=10
EXECUTION_MAX_ITERATIONS=10000     # batch fan-out + workflow.fire children
EXECUTION_MAX_TOKENS=100000        # per-execution agent token budget; 0 = unlimited
```

Durations accept `ms`, `s`, `m`, `h` suffixes or a bare number of
milliseconds. `2s`, `1500ms`, `5m`, `1h`, `45000` all parse.

## DSL fields

Both `timeout` and `nodeTimeout` are optional. Workflows that don't
mention them just inherit the env defaults — backwards-compatible
with every workflow saved before this PR.

```json
{
  "name": "fetch-and-summarise",
  "timeout":       "10m",     // workflow-level wall-clock budget
  "nodeTimeout":   "30s",     // workflow-wide per-node default
  "maxIterations": 500,       // overrides EXECUTION_MAX_ITERATIONS
  "maxTokens":     50000,     // overrides EXECUTION_MAX_TOKENS
  "nodes": [
    {
      "name":    "fetch_url",
      "action":  "http.request",
      "timeout": "5s",        // per-node — overrides nodeTimeout
      "retry":   2,
      "retryDelay": "10s"
    },
    {
      "name":   "summarise",
      "action": "agent",
      "timeout": "2m"         // agents legitimately take longer
    }
  ]
}
```

## What happens when a limit fires

**Node timeout** throws `NodeTimeoutError` from the engine. The
retry loop sees it as a regular failure, so a node with
`retry: 2` gets three timeout attempts before the executor gives
up. After the final attempt the node is marked `failed` and the
existing `onError` semantics decide whether to cascade or continue.

**Workflow timeout** throws `WorkflowTimeoutError`. The worker
catches it in the normal failure path and marks the execution
`failed` with the timeout error. The execution is not retried.

**Retry cap** clamps `node.retry` at save-time-validated DSL
through the engine — a `retry: 9999` becomes `retry: 10` at the
clamp point. No DSL-level error; the cap is silent because the
operator might legitimately want some workflows to retry less than
the cap and others to retry exactly up to it.

**Iteration cap** throws `IterationCapError` *up-front* when:
- `executeBatch` is asked to run more items than the cap allows,
- a node with `batch: true` resolves a `batchOver` array longer
  than the cap, or
- `workflow.fire` is called more times than the cap during a
  single execution (catches "fire in a loop" runaways).

Terminal — the execution fails before any work is done, so a 50k
batch fails in milliseconds instead of consuming the first 10k of
work.

**Token budget exhaustion** throws `BudgetExhaustedError` from
inside the `agent` plugin once the running token total crosses
`maxTokens`. Terminal — the current agent call's result is
discarded and the executor fails the node. Set `maxTokens: 0`
(env or DSL) to disable the check entirely if you want.

**AbortSignal cancellation** is now threaded through
`registry.invoke` as an optional fourth argument. The executor
creates a fresh `AbortController` per node invocation; the timer
that fires `NodeTimeoutError` also aborts the signal. Plugins that
honor it (e.g. `http.request`) shut down their sockets immediately;
plugins that ignore it still get killed at the engine layer with a
small leak window. See "Behaviour caveats" for what unmigrated
plugins look like.

## Behaviour caveats worth knowing

**Promise.race doesn't cancel the underlying work.** When a node
times out, the executor stops waiting and either retries or fails
the node. The plugin's internal promise keeps running in the
background until it resolves on its own. For HTTP plugins that
means a hung socket might keep a file descriptor alive for the OS's
TCP timeout (~tens of seconds). PR 7.x will thread `AbortSignal`
through `registry.invoke` so plugins that want cooperative
cancellation can close their sockets immediately.

**Workflow timeout resets across resume.** A workflow paused by
the `user` plugin is re-enqueued as a fresh BullMQ job when
`/respond` fires. The wall-clock timer is per-job, not per-logical-
execution, so a workflow that pauses for a week and resumes still
gets its full `timeout` budget on the resume run. That's the right
behaviour — we don't want to fail a paused execution at the
30-minute mark because the human took longer to respond.

**Streaming agents need generous budgets.** A `claude-opus-4-6`
call with `max_tokens=4096` can run 60-90 seconds end-to-end. If
you keep the 60s default the agent will time out on long
generations. Either give agent nodes a per-node `timeout: "5m"` or
raise `EXECUTION_DEFAULT_NODE_TIMEOUT`. The follow-up PR will add
"activity-based" timeouts that reset on every streamed chunk.

## Observability

OpenTelemetry spans pick up both budgets as attributes:

- `workflow.run` carries `workflow.timeout_ms`
- `plugin.<name>` carries the resolved node-level budget at start
  (planned in PR 7.x)

A timeout fires as a span event named `exception` with
`exception.type = NodeTimeoutError` / `WorkflowTimeoutError`, so
finding the offender in Tempo / Jaeger is a query against
`exception.type` rather than parsing the log line.

## File map

| File | Role |
|------|------|
| `backend/src/engine/limits.js` | Defaults + duration parser + error classes + `withTimeout` |
| `backend/src/engine/executor.js` | Per-node `withTimeout` wrap + retry clamp |
| `backend/src/worker.js` | Per-workflow `withTimeout` wrap |
| `backend/src/dsl/schema.js` | Accepts `timeout` + `nodeTimeout` |
| `backend/test/limits.test.js` | Unit tests for the layered resolver |
| `backend/.env.example` | `EXECUTION_*` defaults |

## Planned follow-ups

- **AbortSignal across more plugins** — `sql.*`, `agent`,
  `mqtt.publish`, `email.send`. The contract is in place
  (`registry.invoke(name, input, ctx, hooks, { signal })`); each
  plugin needs to honor the signal individually. `http.request`
  is done.
- **Concurrent executions per workspace** — BullMQ group rate-
  limit so one tenant can't starve others.
- **Activity-based node timeout** — for streaming plugins
  (agent), reset the timer on every `hooks.stream.text` chunk
  instead of using a single wall-clock budget.
