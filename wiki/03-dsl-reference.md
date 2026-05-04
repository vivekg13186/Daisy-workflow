# DSL reference

Workflows are YAML documents. The smallest valid one looks like this:

```yaml
name: hello-world
version: "1.0"
nodes:
  - name: greet
    action: log
    inputs:
      message: "Hello!"
```

## Top-level fields

| Field | Required | Notes |
|-------|----------|-------|
| `name` | yes | Flow name. Saved/versioned in the database. |
| `version` | yes | `major.minor`. The graph row's `version` column auto-increments per save. |
| `description` | no | Free text. |
| `data` | no | Object of constants merged into the runtime context root. Acts as defaults that user-supplied JSON input can override. |
| `nodes` | yes | List of node definitions (≥ 1). |
| `edges` | no | List of `{ from, to }` edges. Implicit empty if not provided. |

## Nodes

```yaml
- name: <unique node name>           # required, ^[A-Za-z_][A-Za-z0-9_.-]*$
  action: <plugin id>                # required (e.g. "log", "sql.select")
  description: <free text>           # optional
  inputs:                            # object form, OR array of single-key maps
    key: "expr"                      #   - key: "expr"
  outputs:                           # mapping pluginField -> ctxVar
    pluginField: ctxVarName          # ctxVarName = pluginOutput.pluginField
  executeIf: "${expr}"               # skip this node if false; downstream still runs
  retry: 3                           # default 0
  retryDelay: "500ms"                # number of ms or duration string
  onError: continue                  # continue | terminate (default terminate)
  batchOver: "${array}"              # fan out: run once per item; ${item}, ${index} available
```

**Status values** that show up in the execution viewer / WebSocket events:
`pending`, `running`, `retrying`, `success`, `failed`, `skipped`.

### `inputs` array form (per spec)

The DSL also accepts:

```yaml
inputs:
  - url: "${url}"
  - method: "GET"
outputs:
  - body: bodyVar
```

This is normalized to the object form during parsing. Duplicate keys throw a validation error.

### `outputs` mapping

The mapping is `pluginField → ctxVarName`. Dot paths into the plugin output are supported on the left:

```yaml
outputs:
  body.title: postTitle      # ctx.postTitle = pluginOutput.body.title
  status:    httpStatus      # ctx.httpStatus = pluginOutput.status
```

The full plugin output is also kept under `nodes.<name>.output` regardless of mapping, so you can always reach it via `${nodes.fetch.output.body.title}`.

### `executeIf`

```yaml
executeIf: "${httpStatus == 200}"
```

If the expression is falsy, the node is marked `skipped` and downstream nodes still run (unlike a `failed` node with `onError: terminate`).

### Retries

```yaml
retry: 3            # up to 3 extra attempts (4 total)
retryDelay: "1s"    # number (ms) or "Nms" / "Ns" / "Nm"
```

Retry only applies to plugin-thrown errors. `executeIf` failures, input-resolution errors, and `batchOver` resolution errors don't retry.

### Batch fan-out (`batchOver`)

```yaml
- name: fetch-each
  action: http.request
  batchOver: "${ids}"             # must resolve to an array
  inputs:
    url: "https://api/${item}"
```

The plugin runs once per element; `${item}` is the current element and `${index}` is its index. The node's output is `{ items: [...], count: N }`.

### `onError`

- `terminate` (default) — first failure aborts the DAG. Remaining unrun nodes are marked `skipped`.
- `continue` — failed nodes are recorded, but downstream nodes still run. Final execution status is `partial`.

## Edges

```yaml
edges:
  - { from: greet, to: pause }
  - { from: pause, to: done }
```

A node with no incoming edges is a *root*. Every node must be reachable from the schema (no orphans is not enforced, but all referenced names must exist). Cycles are rejected at validation time.

## Expressions

Anywhere a string value contains `${...}`, the substring is evaluated against the runtime context.

### Path lookup

The simplest expression is a path:

```yaml
url: "${data.url}"
url: "${url}"                                       # same — data is flattened to root
url: "${nodes.fetch.output.body.id}"
```

### Type passthrough

If the entire string is a single `${path}` placeholder, the typed value is returned (number, boolean, array, object). Otherwise the result is interpolated as a string.

```yaml
ms: "${data.timeoutMs}"           # → number 5000  (passed as int to the plugin)
url: "id=${data.id}"              # → string "id=5"
```

### Arithmetic / boolean expressions

When the expression isn't a pure path, it's evaluated by [expr-eval](https://github.com/silentmatt/expr-eval): comparison (`==`, `!=`, `>`, `<`, `>=`, `<=`), logical (`and`, `or`, `not`), arithmetic, ternary (`a ? b : c`), and `in`.

```yaml
executeIf: "${nodes.fetch.output.status == 200}"
executeIf: "${count > 0 and active}"
```

### Recursive resolution

`inputs:` is walked recursively — strings, arrays, and nested objects all get resolved.

```yaml
inputs:
  body:
    user: "${data.user}"
    tags: ["beta", "${data.env}"]
```

## Runtime context

The runtime `ctx` object the engine maintains looks like this for a non-batch run with input `{ "ids": [1,2,3] }`:

```js
ctx = {
  // (1) parsed.data fields, flattened to root, overlaid with the user input.
  ids: [1, 2, 3],

  // (2) per-node summary, populated as nodes complete.
  nodes: {
    fetch: {
      status: "success",
      output: { /* full plugin output */ },
      startedAt: "2026-...", finishedAt: "2026-...",
      attempts: 1
    },
    // ...
  },
}
```

Inside a node running under `batchOver`:

```js
{ ...ctx, item: <current array element>, index: <integer> }
```

After a node finishes successfully, its `outputs:` mapping copies pluginField values onto root-level ctx vars before downstream nodes run.

## Validation

`POST /graphs/validate` (and the editor's **Validate** button) check:

- YAML parses.
- Schema matches.
- Node names are unique and use a safe character set.
- Every edge's `from`/`to` references an existing node.
- The graph is acyclic (Kahn's algorithm).

Anything else (bad expressions, plugin input mismatches) surfaces at run time as a node failure with the error message attached.
