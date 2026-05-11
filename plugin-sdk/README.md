# @daisy-dag/plugin-sdk

Tiny helper for authoring Daisy-DAG external plugins. Implements
the four-endpoint HTTP contract (`/manifest`, `/healthz`, `/readyz`,
`/execute`) so plugin authors only write `execute(input, ctx)`.

Zero runtime dependencies — uses Node's built-in `http` server and
global `fetch`.

## Quick start

```bash
mkdir my-plugin && cd my-plugin
npm init -y
npm install @daisy-dag/plugin-sdk
```

```json
// manifest.json
{
  "name":          "my.plugin",
  "version":       "0.1.0",
  "description":   "Does the thing",
  "primaryOutput": "result",
  "inputSchema":   { "type": "object", "required": ["query"], "properties": { "query": { "type": "string" } } },
  "outputSchema":  { "type": "object", "properties": { "result": { "type": "string" } } },
  "configRefs":    []
}
```

```js
// index.js
import { servePlugin } from "@daisy-dag/plugin-sdk";
import manifest from "./manifest.json" with { type: "json" };

servePlugin({
  manifest,
  async execute(input, ctx) {
    // ctx = { executionId, workspaceId, nodeName, config, deadlineMs, signal }
    return { result: `you said: ${input.query}` };
  },
});
```

Ship it as a container, expose port 8080, install with
`npm run install-plugin -- --endpoint http://my-plugin:8080`.

## Contract details

### `servePlugin(opts)`

| Option   | Required | Description |
|----------|----------|-------------|
| `manifest` | yes | Object matching the plugin manifest schema. |
| `execute`  | yes | `async (input, ctx) => output \| { output, usage }` |
| `readyz`   | no  | `async () => boolean` — return false to make `/readyz` respond 503. Default: always true. |
| `port`     | no  | Listen port. Default: `PORT` env or `8080`. |
| `host`     | no  | Bind host. Default: `0.0.0.0`. |
| `log`      | no  | `(level, msg, meta) => void`. Default: stdout/stderr JSON lines. |

### `ctx` inside execute

```js
{
  executionId: "uuid",    // the workflow execution that's running you
  workspaceId: "uuid",    // for scoping / audit
  nodeName:    "string",  // the DSL node that resolved to this plugin
  config:      { },       // plaintext values for configs declared in configRefs
  deadlineMs:  60000,     // wall-clock budget set by the engine
  signal:      AbortSignal // pass to fetch / pg / etc. for cooperative cancellation
}
```

When the engine times out OR the workflow user cancels, `signal`
aborts. Pass it to any outbound call that supports
`AbortController` and your plugin shuts down its work cleanly
instead of running detached for another N seconds.

### Return value

Either:

```js
return { result: "..." };                       // whole object is the output
// or
return { output: { result: "..." }, usage: {} }; // explicit
```

The engine validates against `outputSchema` from the manifest. A
return that doesn't match throws on the engine side.

### Errors

Throwing inside `execute()` produces a 500 response with
`{ error: "<message>" }`. The engine surfaces these as node
failures and applies its retry / timeout / self-heal policies.

## Example: real plugin

See `plugins-external/reddit/` in the Daisy-DAG repo — a real
external plugin in ~25 lines of code using this SDK.

## What's NOT in this SDK (yet)

- **Streaming.** `/execute` is synchronous request/response in Phase
  1+2. Streaming hooks (`ctx.stream.text(...)`) come in Phase 3
  via a server-sent-events callback URL.
- **Auto-registration.** Plugins still install via the engine's
  CLI / admin UI. The SDK doesn't try to call back to the engine.
- **Schema validation.** The engine validates input/output against
  the manifest schemas. The SDK trusts what comes in and what
  `execute()` returns.
