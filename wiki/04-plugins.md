# Plugin reference

Built-in plugins, grouped by purpose. Every plugin is a `.js` file under `backend/src/plugins/builtin/` — drop a new file there with the right shape and it auto-registers on the next worker start.

The full set, alphabetically:
`agent`, `csv.read`, `csv.write`, `delay`, `email.send`, `excel.read`, `excel.write`, `file.delete`, `file.list`, `file.read`, `file.stat`, `file.write`, `http.request`, `log`, `mqtt.publish`, `sql.delete`, `sql.execute`, `sql.insert`, `sql.select`, `sql.update`, `transform`, `web.scrape`.

> **Removed:** the dedicated `condition` plugin is gone — gate downstream
> nodes with `executeIf` instead. The visual editor reads each plugin's
> JSON Schema and renders the property panel from it, so what you see in
> the canvas is always in sync with what's documented here.

The live list (with input/output schemas) is also at `GET /plugins`. The AI assistant uses it for autocomplete and code generation.

---

## Core

### `log`

Print a message to the worker's stdout (and to `node-events.log`).

```json
{
  "action": "log",
  "inputs": {
    "message": "Hello, ${name}!",
    "level":   "info"
  }
}
```

Output: `{ message }` — passes the rendered string through, useful as a downstream expression source. `primaryOutput: "message"`.

---

### `delay`

Sleep for `ms` milliseconds. Hard ceiling 24h (anything longer should use a `schedule` trigger). Handy for throttling, demos, or synthetic timing tests.

```json
{
  "action": "delay",
  "inputs": { "ms": 500 }
}
```

Output: `{ slept: <ms> }`. `primaryOutput: "slept"`.

---

### `transform`

Evaluate a FEEL expression and return the result under `value`. The dedicated `condition` plugin was removed — to gate nodes by a boolean, use `executeIf` directly on the downstream node and read the upstream value from `${nodes.<name>.output.value}` or via an `outputVar`.

```json
{
  "action": "transform",
  "inputs": {
    "expression": "{ summary: nodes.fetch.output.body.title, authorId: nodes.fetch.output.body.userId }"
  }
}
```

The expression is **raw FEEL** — no `${…}` wrapping. Examples:

- `"user.firstName + \" \" + user.lastName"` → string
- `"for o in orders return o.total"` → list
- `"if x > 0 then \"positive\" else \"non-positive\""` → string

Output: `{ value: <whatever your expression evaluated to> }`. `primaryOutput: "value"`.

---

## AI

### `agent`

Run a stored LLM agent against an input text. Each agent is a named persona — system prompt + linked `ai.provider` configuration — managed from Home → Agents. Multiple workflow nodes can reference the same agent by title.

```json
{
  "action": "agent",
  "inputs": {
    "agent":     "Sentiment Analyser",
    "input":     "${data.reviewText}",
    "maxTokens": 1024
  }
}
```

Output (fixed wrapper):

```js
{
  result:     /* parsed JSON object/array, or null on parse fail */,
  confidence: /* number 0–1, plucked from result.confidence (also accepts 0–100, normalised); null if absent */,
  raw:        /* full text response from the model */,
  usage:      { inputTokens, outputTokens }
}
```

`primaryOutput: "result"`. Set up the agent first: Home → Configurations → +New → type **AI provider** (provider, apiKey, model), then Home → Agents → +New (title, prompt, pick the config). The system prompt accepts markdown — the editor has Edit / Split / Preview modes.

See [`plugins/agent.md`](./plugins/agent.md) for prompt patterns, branch-on-confidence examples, and troubleshooting.

---

## HTTP

### `http.request`

Native `fetch` wrapper. Supports JSON or string bodies, custom headers, configurable timeout.

```json
{
  "action": "http.request",
  "inputs": {
    "url":     "https://api.example.com/users/${userId}",
    "method":  "GET",
    "headers": { "authorization": "Bearer ${token}" },
    "body":    { "name": "Alice" },
    "timeoutMs": 15000
  }
}
```

Methods: `GET POST PUT PATCH DELETE HEAD` (default `GET`). Body: object → JSON.stringify; string → sent as-is. Timeout default 15000, max 60000.

Output:

```js
{
  status:  200,
  headers: { /* response headers */ },
  body:    /* parsed JSON if possible, otherwise raw text */
}
```

Non-2xx responses don't throw — `status` is returned as-is. Use `executeIf` or `onError` to react. `primaryOutput: "body"`.

---

## Web scraping

### `web.scrape`

Fetch a URL, parse with JSDOM, run any number of CSS or XPath queries against it. The schema is scrape-shaped, not http-shaped: the inputs are URL + selectors first, then the optional headers / timeout / baseUrl knobs. (`method` and `body` were dropped — almost every scrape is a GET; use `http.request` if you need a POST that returns a body to extract from.)

```json
{
  "action": "web.scrape",
  "inputs": {
    "url": "https://example.com",
    "queries": [
      { "name": "title",    "type": "css",   "selector": "h1" },
      { "name": "links",    "type": "css",   "selector": "a", "attr": "href", "all": true },
      { "name": "bodyHtml", "type": "css",   "selector": "main", "extract": "outerHTML" },
      { "name": "priceTxt", "type": "xpath", "selector": "//*[@class='price']/text()" },
      { "name": "pCount",   "type": "xpath", "selector": "count(//p)" }
    ],
    "timeoutMs": 10000
  }
}
```

Each query:
- `name` (required) — the key under `results`.
- `type` — `css` (default) or `xpath`.
- `selector` — CSS selector or XPath expression.
- `extract` — `text` (default), `html`, `outerHTML`, or `attr`.
- `attr` — attribute name (also implies `extract: attr`).
- `all` — `true` returns array of matches; `false` (default) returns the first match or null.

Output: `{ url, status, headers, results: { name: value, ... } }`. Per-query failures are captured as `{ __error: "..." }` so one bad selector doesn't lose the rest. `primaryOutput: "results"`.

XPath primitives (`count()`, `string()`, `boolean()`, etc.) are detected and return the raw number/string/boolean.

---

## SQL (Postgres-compatible)

All five SQL plugins share the same three-input shape: **`config` + `sql` + `params`**. There's no per-call connection string and no structured-form helpers any more — you write the parameterised SQL yourself, and the connection comes from a stored **database** configuration.

### Setup once

1. Home → **Configurations** → **+ New** → type **database**.
2. Fill in `host`, `port`, `database`, `username`, `password`, `ssl`. The password is encrypted at rest (AES-256-GCM keyed by `CONFIG_SECRET`).
3. Reference it from the plugin's `config` input by its **name**.

The engine assembles a `postgres://user:pass@host:port/db[?sslmode=require]` connection string from those fields and pools per-string.

### Shared schema

| Input | Required | Description |
|-------|----------|-------------|
| `config` | yes | Name of a stored database configuration. |
| `sql` | yes | The query text. Use `$1`, `$2`, … for placeholders. (Multi-line; the property panel renders this as a textarea.) |
| `params` | no | Reference (`${var}`) to an array of bound values for `$1`, `$2`, … Build the array upstream with a `transform` node, or omit the field if the SQL has no placeholders. |

Output: `{ rows, rowCount }` for every plugin. `primaryOutput: "rows"`.

### `sql.select`

```json
{
  "action": "sql.select",
  "inputs": {
    "config": "prodDb",
    "sql":    "SELECT id, email FROM users WHERE active = $1 ORDER BY id LIMIT $2",
    "params": "${queryParams}"
  }
}
```

### `sql.insert`

Add a `RETURNING` clause if you need the inserted rows back.

```json
{
  "action": "sql.insert",
  "inputs": {
    "config": "prodDb",
    "sql":    "INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id, name, email",
    "params": ["Alice", "alice@example.com"]
  }
}
```

### `sql.update`

Always include a `WHERE` clause — there's no safety net any more (the `unsafe` flag is gone with the structured form).

```json
{
  "action": "sql.update",
  "inputs": {
    "config": "prodDb",
    "sql":    "UPDATE users SET tier = $1 WHERE email = $2 RETURNING id, tier",
    "params": ["pro", "alice@example.com"]
  }
}
```

### `sql.delete`

Same — include a `WHERE`.

```json
{
  "action": "sql.delete",
  "inputs": {
    "config": "prodDb",
    "sql":    "DELETE FROM sessions WHERE expires_at < NOW() RETURNING id"
  }
}
```

### `sql.execute`

The escape hatch for stored procedures, table-returning functions, DDL, and anything else that doesn't fit the four CRUD pigeonholes. Same shape — write the SQL.

```json
{
  "action": "sql.execute",
  "inputs": {
    "config": "prodDb",
    "sql":    "CALL refresh_reports($1)",
    "params": ["fast_mode"]
  }
}
```

```json
{
  "action": "sql.execute",
  "inputs": {
    "config": "prodDb",
    "sql":    "SELECT * FROM get_daily_summary($1)",
    "params": ["2026-05-06"]
  }
}
```

---

## Email

### `email.send`

SMTP via nodemailer. Configure the transport with a stored **mail.smtp** configuration; reference it by name from `config`.

#### Setup once

1. Home → **Configurations** → **+ New** → type **mail.smtp**.
2. Fill in `host`, `port`, `secure`, `username`, `password`, optional `from`. The password is encrypted at rest.
3. Reference the config by its name from any number of `email.send` nodes.

```json
{
  "action": "email.send",
  "inputs": {
    "config":  "sendgrid",
    "to":      "ops@example.com",
    "cc":      ["a@x.com", "b@x.com"],
    "bcc":     "c@x.com",
    "from":    "DAG Engine <noreply@example.com>",
    "replyTo": "support@example.com",
    "subject": "Build #${nodes.build.output.id} succeeded",
    "text":    "Plain-text body — ${name}",
    "html":    "<p>HTML body — <strong>${name}</strong></p>",
    "headers": { "x-flow-id": "${flowId}" },
    "attachments": [
      { "filename": "report.csv", "path": "/tmp/report.csv" },
      { "filename": "inline.txt", "content": "hi", "contentType": "text/plain" }
    ]
  }
}
```

`from` is optional on the node — falls back to the config's `from`, then to the config's `username`. `to`, `cc`, `bcc` accept either a single string or an array.

Output:

```js
{
  messageId: "<...>",
  accepted:  ["ops@example.com"],
  rejected:  [],
  response:  "250 OK ...",
  envelope:  { from: "...", to: ["..."] },
  preview:   "..."   // populated only in jsonTransport (dry-run) mode
}
```

`primaryOutput: "messageId"`.

---

## MQTT

### `mqtt.publish`

Publish a single MQTT message. The `config` input names a stored **mqtt** configuration that supplies the broker URL and credentials.

#### Setup once

1. Home → **Configurations** → **+ New** → type **mqtt**.
2. Fill in `url` (`mqtt://...` / `mqtts://...` / `ws://...` / `wss://...`), optional `clientId`, optional `username`, optional `password`.
3. Reference the config by name from `mqtt.publish` nodes (and from the `mqtt` trigger if you want to subscribe).

```json
{
  "action": "mqtt.publish",
  "inputs": {
    "config":  "homeAssistant",
    "topic":   "home/automation/dag-engine",
    "payload": { "ok": true, "at": "${data.now}" },
    "qos":     0,
    "retain":  false
  }
}
```

Payload encoding:
- `string` → sent on the wire verbatim.
- `Buffer` → sent as-is.
- anything else → JSON.stringify.

Output: `{ topic, bytes, qos, retain, messageId }`. `primaryOutput: "messageId"`.

---

## File I/O

All file plugins go through a shared `resolveSafePath()` helper. When `FILE_ROOT` is set in the env, paths must resolve inside it; absolute paths outside the root are rejected.

### `file.read`

```json
{
  "action": "file.read",
  "inputs": {
    "path":     "data/input.txt",
    "encoding": "utf8"
  }
}
```

Encoding: `utf8` | `utf-8` | `ascii` | `latin1` | `base64` (default `utf8`).

Output: `{ path, content, size, encoding }`. `primaryOutput: "content"`.

### `file.write`

```json
{
  "action": "file.write",
  "inputs": {
    "path":     "out/result.txt",
    "content":  "${nodes.summarize.output.text}",
    "encoding": "utf8",
    "mode":     "overwrite",
    "mkdir":    true
  }
}
```

`mode`: `overwrite` (default) | `append`. `mkdir`: create parent dirs (default false). Use `encoding: "base64"` to write binary.

Output: `{ path, size }`. `primaryOutput: "path"`.

### `file.list`

```json
{
  "action": "file.list",
  "inputs": {
    "path":          "/data",
    "pattern":       "*.csv",
    "recursive":     false,
    "includeHidden": false
  }
}
```

`pattern` is a simple `*` / `?` glob on the basename.

Output: `{ entries: [{ name, path, isFile, isDirectory, size, mtime }, ...], count }`. `primaryOutput: "entries"`.

### `file.delete`

```json
{
  "action": "file.delete",
  "inputs": {
    "path":      "/data/old.txt",
    "recursive": false,
    "missingOk": false
  }
}
```

`recursive: true` is required to remove a non-empty directory. `missingOk: true` returns `{ deleted: false }` instead of throwing on ENOENT.

Output: `{ path, deleted }`. `primaryOutput: "deleted"`.

### `file.stat`

Never throws on ENOENT — returns `exists: false` instead. Useful as an `executeIf:` gate.

```json
{
  "name": "check",
  "action": "file.stat",
  "inputs": { "path": "/data/in.csv" }
}
```

```json
{
  "name": "process",
  "action": "csv.read",
  "executeIf": "${nodes.check.output.exists}",
  "inputs": { "path": "/data/in.csv" }
}
```

Output: `{ path, exists, isFile?, isDirectory?, size?, mtime? }`.

---

## CSV

### `csv.read`

Parse a CSV file (`path:`) or inline string (`text:`).

```json
{
  "action": "csv.read",
  "inputs": {
    "path":      "/data/orders.csv",
    "delimiter": ",",
    "headers":   true,
    "skipEmpty": true,
    "cast":      true
  }
}
```

With `headers: true` (default), rows come back as objects keyed by header. With `headers: false`, rows are arrays.

Output: `{ path?, rows, rowCount, columns }`. `primaryOutput: "rows"`.

### `csv.write`

Write a 2D array of values to disk. The first row is treated as the column headers; the rest are data rows. `data` is intentionally a typeless single-line input — you wire it to a 2D array built upstream by a `transform` node.

```json
{
  "action": "csv.write",
  "inputs": {
    "path":      "/data/out.csv",
    "data":      "${matrix}",
    "delimiter": ",",
    "mkdir":     true
  }
}
```

`${matrix}` should resolve to:

```js
[
  ["id", "name"],     // headers
  [1,    "Alice"],
  [2,    "Bob"]
]
```

Omit `path` to get the rendered text back on `output.text` instead of writing.

Output: `{ path?, text?, rowCount }`. `primaryOutput: "path"`.

---

## Excel

Backed by [exceljs](https://github.com/exceljs/exceljs).

### `excel.read`

```json
{
  "action": "excel.read",
  "inputs": {
    "path":      "/data/report.xlsx",
    "sheet":     "Orders",
    "headers":   true,
    "allSheets": false
  }
}
```

Single-sheet output: `{ path, sheet, columns, rows, rowCount }`.
Multi-sheet output (with `allSheets: true`): `{ path, sheets: [{ sheet, columns, rows, rowCount }, ...] }`.

Cell values are normalised — formulas become their resolved `result`, hyperlinks become their text, dates become ISO strings.

`primaryOutput: "rows"`.

### `excel.write`

Same `data` shape as `csv.write` — a 2D array, headers first row.

```json
{
  "action": "excel.write",
  "inputs": {
    "path":  "/data/out.xlsx",
    "sheet": "People",
    "data":  "${matrix}",
    "mkdir": true
  }
}
```

The first row gets bolded automatically. The plugin writes one sheet per call; if you need multiple sheets, run several `excel.write` nodes (or build a custom plugin).

Output: `{ path, sheet, rowCount }`. `primaryOutput: "path"`.

---

## Adding your own plugin

Create a new file in `backend/src/plugins/builtin/`. Default-export an object with `name`, `description`, optional `inputSchema`/`outputSchema` (JSON Schema, validated by ajv), `primaryOutput` (the key on the output object that `outputVar` will copy into ctx), and `async execute(input, ctx)`:

```js
// backend/src/plugins/builtin/uppercase.js
export default {
  name: "uppercase",
  description: "Returns its input string in uppercase.",

  inputSchema: {
    type: "object",
    required: ["text"],
    properties: { text: { type: "string", title: "Text" } },
  },

  primaryOutput: "text",

  outputSchema: {
    type: "object",
    required: ["text"],
    properties: { text: { type: "string" } },
  },

  async execute({ text }, ctx) {
    return { text: text.toUpperCase() };
  },
};
```

Restart the worker (or `npm run dev` will pick it up via `--watch`). The plugin shows up in `GET /plugins`, in the canvas's left palette, and in the AI assistant's system prompt automatically. The property panel renders inputs from `inputSchema` (with `title`, `description`, and `format: "textarea"` honoured), and the **Returns** panel surfaces `outputSchema` so flow authors can see what `${nodes.<name>.output.<field>}` will give them.

### Schema → editor mapping cheat-sheet

| Schema property | Property panel widget |
|-----------------|-----------------------|
| `enum: [...]` | select |
| `type: "boolean"` | toggle |
| `type: "integer"` / `"number"` | numeric input |
| `type: "array", items.type: "string"` | string list |
| `type: "array", items.type: "object", items.properties: {...}` | table |
| `type: "string", format: "textarea"` | multi-line textarea |
| `type: "object"` (or unsupported types) | JSON textarea (parsed on commit) |
| no `type` declared | plain text input — used for `${var}` references where the engine resolves to whatever shape the plugin needs |
| anything else | text input |

Use no-type for fields like `params` / `data` / `payload` where the user types a `${var}` reference and the engine resolves it before the plugin sees it.
