# Live integration tests

Jest + Supertest suite that exercises every builtin plugin against a
running DAG-engine API. Each test:

1. `POST /graphs` to create a single-node graph
2. `PUT /graphs/:id` to update it (matches the "update with JSON" spec)
3. `POST /graphs/:id/execute` to enqueue a run
4. polls `GET /executions/:id` until terminal status
5. asserts the per-node output recorded under `executions.context.nodes`

## Prerequisites

- Postgres + Redis + the worker + the API server all running
- A populated `dvd_rental` (Pagila) database for the SQL suite
- Three stored configurations in your DAG-engine instance:
  - **`test_send_email`** — type `mail.smtp` (Mailpit, sendmail, etc.)
  - **`test_database`** — type `database`, pointing at your dvd_rental DB
  - **`test_mqtt`** — type `mqtt`, broker URL + creds

## Install + run

```bash
cd test
npm install
npm test                     # whole suite (sequential)
npm run test:sql             # one node category
npm run test:mqtt
```

Override behaviour via env vars:

| var | default | purpose |
|---|---|---|
| `API_BASE` | `http://localhost:3000` | server URL |
| `CONFIG_EMAIL` | `test_send_email` | stored email config name |
| `CONFIG_DATABASE` | `test_database` | stored database config name |
| `CONFIG_MQTT` | `test_mqtt` | stored mqtt config name |
| `TEST_HTTP_URL` | `https://httpbin.org/get?probe=dag-engine` | URL hit by `http.request` test |
| `TEST_SCRAPE_URL` | `https://example.com/` | URL hit by `web.scrape` test |
| `TEST_TMP_DIR` | `<os.tmpdir>/dag-engine-livetest` | scratch dir for `file.*`, `csv.*`, `excel.*` tests; set this **inside** `FILE_ROOT` if your backend has it configured |

## Coverage

| File | Plugins exercised |
|---|---|
| `tests/log.test.js` | `log` |
| `tests/delay.test.js` | `delay` |
| `tests/transform.test.js` | `transform` (FEEL evaluation) |
| `tests/http.test.js` | `http.request` |
| `tests/web-scrape.test.js` | `web.scrape` |
| `tests/file.test.js` | `file.write` / `file.stat` / `file.list` / `file.read` / `file.delete` |
| `tests/csv.test.js` | `csv.write` / `csv.read` |
| `tests/excel.test.js` | `excel.write` / `excel.read` |
| `tests/email.test.js` | `email.send` (uses `test_send_email`) |
| `tests/mqtt.test.js` | `mqtt.publish` (uses `test_mqtt`) |
| `tests/sql.test.js` | `sql.select` / `sql.insert` / `sql.update` / `sql.delete` / `sql.execute` (uses `test_database`) |

## Cleanup

Each test deletes the workflows it created in `afterAll`, and the SQL
suite drops its scratch table on teardown. Failed runs may leave a few
soft-deleted graph rows behind — those are harmless, but if you want a
clean slate you can purge them from `graphs WHERE name LIKE 'livetest-%'`.
