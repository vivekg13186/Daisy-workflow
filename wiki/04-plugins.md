# Plugin reference

21 built-in plugins, grouped by purpose. Every plugin is a `.js` file under `backend/src/plugins/builtin/` — drop a new file there with the right shape and it auto-registers on the next worker start.

The full set, alphabetically:
`condition`, `csv.read`, `csv.write`, `delay`, `email.send`, `excel.read`, `excel.write`, `file.delete`, `file.list`, `file.read`, `file.stat`, `file.write`, `http.request`, `log`, `sql.delete`, `sql.execute`, `sql.insert`, `sql.select`, `sql.update`, `transform`, `web.scrape`.

The live list (with input/output schemas) is also at `GET /plugins`. The YAML editor uses it for autocomplete.

---

## Core

### `log`

Print a message to the worker's stdout (and to the `node-events.log` file).

```yaml
- action: log
  inputs:
    message: "Hello, ${name}!"
    level: info        # debug | info | warn | error (default info)
```

Output: `{ message }` — passes the rendered string through, useful as a downstream expression source.

---

### `delay`

Sleep for `ms` milliseconds. Handy for throttling, demos, or synthetic timing tests.

```yaml
- action: delay
  inputs:
    ms: 500            # 0–60000
```

Output: `{ slept: <ms> }`.

---

### `transform`

Identity transform — returns whatever you put in `value`. Use it to reshape data with `${...}` expressions.

```yaml
- action: transform
  inputs:
    value:
      summary: "${nodes.fetch.output.body.title}"
      authorId: "${nodes.fetch.output.body.userId}"
```

Output: `{ value: <whatever you passed> }`.

---

### `condition`

Coerces `value` to a boolean. Combine with downstream `executeIf` to gate branches.

```yaml
- name: check
  action: condition
  inputs:
    value: "${count > 0}"
- name: act
  action: log
  executeIf: "${nodes.check.output.result}"
  inputs: { message: "have items" }
```

Output: `{ result: <boolean> }`.

---

## HTTP

### `http.request`

Native `fetch` wrapper. Supports JSON or string bodies, custom headers, configurable timeout.

```yaml
- action: http.request
  inputs:
    url: "https://api.example.com/users/${userId}"
    method: GET                        # GET POST PUT PATCH DELETE HEAD (default GET)
    headers:
      authorization: "Bearer ${token}"
    body:                              # object → JSON.stringify; string → sent as-is
      name: "Alice"
    timeoutMs: 15000                   # default 15000, max 60000
```

Output:

```js
{
  status:  200,
  headers: { /* response headers */ },
  body:    /* parsed JSON if possible, otherwise raw text */
}
```

Non-2xx responses don't throw — `status` is returned as-is. Use `executeIf` or `onError` to react.

---

## Web scraping

### `web.scrape`

Fetch a URL, parse with JSDOM, run any number of CSS or XPath queries against it.

```yaml
- action: web.scrape
  inputs:
    url: "https://example.com"
    timeoutMs: 10000
    queries:
      - { name: title,    type: css,   selector: "h1" }
      - { name: links,    type: css,   selector: "a", attr: "href", all: true }
      - { name: bodyHtml, type: css,   selector: "main", extract: outerHTML }
      - { name: priceTxt, type: xpath, selector: "//*[@class='price']/text()" }
      - { name: pCount,   type: xpath, selector: "count(//p)" }   # primitive
```

Each query:
- `name` (required) — the key under `results`.
- `type` — `css` (default) or `xpath`.
- `selector` — CSS selector or XPath expression.
- `extract` — `text` (default), `html`, `outerHTML`, or `attr`.
- `attr` — attribute name (also implies `extract: attr`).
- `all` — `true` returns array of matches; `false` (default) returns the first match or null.

Output: `{ url, status, headers, results: { name: value, ... } }`. Per-query failures are captured as `{ __error: "..." }` so one bad selector doesn't lose the rest.

XPath primitives (`count()`, `string()`, `boolean()`, etc.) are detected and return the raw number/string/boolean.

---

## SQL (Postgres-compatible)

All SQL plugins share the same shape: either supply a raw `query` + `params`, or use the structured form (`table` + ...). Default connection is the engine's own `DATABASE_URL`; pass `connectionString:` per-call to point anywhere else.

Connections are pooled per distinct `connectionString`. Identifier names are validated against `^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$` and quoted; values use parameterized binding.

### `sql.select`

```yaml
# Structured form
- action: sql.select
  inputs:
    table: users
    columns: ["id", "email"]                # default *
    where: { active: true }                 # null → IS NULL; arrays → = ANY($N)
    orderBy: "id DESC"                      # validated regex; col + ASC/DESC + NULLS FIRST/LAST
    limit: 10
    offset: 0

# Raw form
- action: sql.select
  inputs:
    query: "SELECT * FROM users WHERE id = $1"
    params: ["${userId}"]
```

Output: `{ rows: [...], rowCount: N }`.

### `sql.insert`

```yaml
- action: sql.insert
  inputs:
    table: users
    values: { email: "${email}", name: "Alice" }     # object → 1 row
    # values: [{...}, {...}]                         # array → bulk insert
    returning: ["id", "email"]                       # optional
    onConflict: nothing                              # nothing | error (default error)
```

Output: `{ rows, rowCount }`.

### `sql.update`

```yaml
- action: sql.update
  inputs:
    table: users
    set:   { tier: "pro" }
    where: { email: "${email}" }
    returning: ["id", "tier"]
```

**Refuses an UPDATE without a WHERE** unless `unsafe: true`.

### `sql.delete`

```yaml
- action: sql.delete
  inputs:
    table: users
    where: { id: 42 }
    returning: ["id"]
```

Same `unsafe: true` guard against accidental table-wipe.

### `sql.execute`

For stored procedures, table-returning functions, or arbitrary statements.

```yaml
# Stored procedure: CALL fn($1, $2)
- action: sql.execute
  inputs:
    procedure: "calculate_total"
    args: [123, "USD"]

# Table-returning function: SELECT * FROM fn($1, ...)
- action: sql.execute
  inputs:
    function: "current_database"

# Raw query
- action: sql.execute
  inputs:
    query: "TRUNCATE TABLE staging RESTART IDENTITY"
```

Output: `{ rows, rowCount }`.

---

## Email

### `email.send`

SMTP via nodemailer. Configure the default transport with `SMTP_*` env vars; override per-call with `smtp: { host, port, secure, user, pass }`. Set `SMTP_HOST=json` (or `smtp.host=json`) for a dry-run that renders the message but doesn't dispatch — perfect for tests.

```yaml
- action: email.send
  inputs:
    to: "ops@example.com"                    # string or array
    cc: ["a@x.com", "b@x.com"]
    bcc: "c@x.com"
    from: "DAG Engine <noreply@example.com>" # falls back to SMTP_FROM
    replyTo: "support@example.com"
    subject: "Build #${nodes.build.output.id} succeeded"
    text:    "Plain-text body — ${name}"
    html:    "<p>HTML body — <strong>${name}</strong></p>"
    headers:
      "x-flow-id": "${flowId}"
    attachments:
      - { filename: "report.csv", path: "/tmp/report.csv" }
      - { filename: "inline.txt", content: "hi", contentType: "text/plain" }
    smtp:                                    # per-call override (optional)
      host: smtp.mailgun.org
      port: 587
      user: postmaster@...
      pass: ...
```

Output:

```js
{
  messageId: "<...>",
  accepted:  ["ops@example.com"],
  rejected:  [],
  response:  "250 OK ...",
  envelope:  { from: "...", to: ["..."] },
  preview:   "..."        // populated only in jsonTransport mode
}
```

---

## File I/O

All file plugins go through a shared `resolveSafePath()` helper. When `FILE_ROOT` is set in the env, paths must resolve inside it; absolute paths outside the root are rejected.

### `file.read`

```yaml
- action: file.read
  inputs:
    path: "data/input.txt"
    encoding: utf8        # utf8 | utf-8 | ascii | latin1 | base64 (default utf8)
```

Output: `{ path, content, size, encoding }`.

### `file.write`

```yaml
- action: file.write
  inputs:
    path: "out/result.txt"
    content: "${nodes.summarize.output.text}"
    encoding: utf8        # base64 to write binary
    mode: overwrite       # overwrite | append (default overwrite)
    mkdir: true           # create parent dirs (default false)
```

Output: `{ path, size }`.

### `file.list`

```yaml
- action: file.list
  inputs:
    path: "/data"
    pattern: "*.csv"      # optional, simple * / ? glob on basename
    recursive: false      # default false
    includeHidden: false  # default false
```

Output: `{ entries: [{ name, path, isFile, isDirectory, size, mtime }, ...], count }`.

### `file.delete`

```yaml
- action: file.delete
  inputs:
    path: "/data/old.txt"
    recursive: false      # required true to delete a non-empty dir
    missingOk: false      # don't throw on ENOENT if true
```

Output: `{ path, deleted: <boolean> }`.

### `file.stat`

Never throws on ENOENT — returns `exists: false` instead. Useful as an `executeIf:` gate.

```yaml
- name: check
  action: file.stat
  inputs: { path: "/data/in.csv" }
- name: process
  action: csv.read
  executeIf: "${nodes.check.output.exists}"
  inputs: { path: "/data/in.csv" }
```

Output: `{ path, exists, isFile?, isDirectory?, size?, mtime? }`.

---

## CSV

### `csv.read`

Parse a CSV file (`path:`) or inline string (`text:`).

```yaml
- action: csv.read
  inputs:
    path: "/data/orders.csv"
    delimiter: ","          # default ","
    headers: true           # default true → array of objects keyed by header
    skipEmpty: true
    cast: true              # auto-cast numbers / booleans (default true)
```

With `headers: false`, rows come back as arrays.

Output: `{ path?, rows, rowCount, columns }`.

### `csv.write`

Serialize rows to CSV. Either write to disk or return the rendered text.

```yaml
- action: csv.write
  inputs:
    path: "/data/out.csv"          # omit to return text instead
    rows:                          # objects (auto-headers from keys) OR arrays
      - { id: 1, name: Alice }
      - { id: 2, name: Bob }
    headers: ["id", "name"]        # explicit column order (optional)
    delimiter: ","
    header: true                   # emit header row (default true)
    mkdir: true                    # create parent dirs
```

Output: `{ path?, text?, rowCount }`.

---

## Excel

Backed by [exceljs](https://github.com/exceljs/exceljs).

### `excel.read`

```yaml
- action: excel.read
  inputs:
    path: "/data/report.xlsx"
    sheet: "Orders"           # optional; default = first sheet
    headers: true             # use first row as keys (default true)
    allSheets: false          # true returns sheets[] for every worksheet
```

Single-sheet output: `{ path, sheet, columns, rows, rowCount }`.
Multi-sheet output: `{ path, sheets: [{ sheet, columns, rows, rowCount }, ...] }`.

Cell values are normalized — formulas become their resolved `result`, hyperlinks become their text, dates become ISO strings.

### `excel.write`

Single-sheet:

```yaml
- action: excel.write
  inputs:
    path: "/data/out.xlsx"
    sheet: "People"             # default "Sheet1"
    rows: "${nodes.csv-read.output.rows}"
    headers: ["name", "age"]    # optional explicit order
    mkdir: true
```

Multi-sheet:

```yaml
- action: excel.write
  inputs:
    path: "/data/out.xlsx"
    sheets:
      - name: People
        rows: [{ name: Alice, age: 30 }, { name: Bob, age: 25 }]
      - name: Cities
        headers: ["city", "count"]
        rows:
          - { city: Berlin, count: 1 }
          - { city: Paris,  count: 1 }
```

Object rows automatically produce a bolded header row inferred from keys (union, first-seen order). Array rows pass through as-is with no header.

Output: `{ path, sheets: [{ name, rowCount }, ...] }`.

---

## Adding your own plugin

Create a new file in `backend/src/plugins/builtin/`. Default-export an object with `name`, `description`, optional `inputSchema`/`outputSchema` (JSON Schema, validated by ajv), and `async execute(input, ctx)`:

```js
// backend/src/plugins/builtin/uppercase.js
export default {
  name: "uppercase",
  description: "Returns its input string in uppercase.",
  inputSchema: {
    type: "object",
    required: ["text"],
    properties: { text: { type: "string" } },
  },
  outputSchema: {
    type: "object",
    required: ["text"],
    properties: { text: { type: "string" } },
  },
  async execute({ text }) {
    return { text: text.toUpperCase() };
  },
};
```

Restart the worker (or `npm run dev` will pick it up via `--watch`). The plugin shows up in `GET /plugins`, in the YAML editor's `action:` autocomplete, and in the AI assistant's system prompt automatically.
