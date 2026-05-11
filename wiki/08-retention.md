# Retention

How Daisy keeps Postgres tidy. Default policies prune old executions,
expired refresh tokens, and the long tail of conversation history.
Active resources (graphs, configs, agents, triggers, archives, KV
memory) are *never* touched — those are user-curated.

## Activate it

Retention is **opt-in**. In `backend/.env` (or your deploy config):

```bash
RETENTION_ENABLED=true
RETENTION_SCHEDULE=0 3 * * *            # daily at 03:00 local time
```

Restart the worker. You should see this line on boot:

```
{ msg: "retention scheduled", schedule: "0 3 * * *", timezone: "local", nextRun: "..." }
```

If you'd rather not wait until 03:00 to verify it works:

```bash
npm run retention                       # one-off pass, prints JSON summary
```

The CLI runs regardless of `RETENTION_ENABLED`, so you can test
windows before flipping the schedule on.

## Default policies

| Policy | What it deletes | Default window |
|--------|-----------------|----------------|
| Executions (success) | rows in `executions` + cascaded `node_states` | older than 90 days |
| Executions (failed)  | rows in `executions` with `status IN ('failed','cancelled','partial')` | older than 180 days |
| Refresh tokens | rows in `refresh_tokens` whose `revoked_at` OR `expires_at` is set | older than 30 days |
| Conversation history | rows in `memories` where `namespace='history'`, keeping the most recent N turns per conversation | keep 100 |

KV memory (`namespace='kv'`), graphs, configs, agents, triggers,
archived_graphs, users, workspaces — **none** of these are subject
to retention. They're user data.

The longer window for failed executions is deliberate. When
someone reports "this workflow broke two months ago", the failed
run is exactly the row you want to look at.

## Tuning

Every window is env-driven, no code change required:

```bash
RETENTION_EXECUTIONS_SUCCESS_DAYS=90
RETENTION_EXECUTIONS_FAILED_DAYS=180
RETENTION_REFRESH_TOKENS_DAYS=30
RETENTION_HISTORY_TURNS_PER_CONVERSATION=100
```

Setting any window to a very small value (1, 0) is a fine
"empty-out the table" trick for debug environments. Don't do that
in production.

## Bounded DELETEs

Each policy is wrapped in a `LIMIT $batch` so one pass can't lock
a busy table for minutes. Default `RETENTION_BATCH_LIMIT=50000`.
When a policy hits the limit (meaning "there's more to delete"),
the runner re-fires it up to `RETENTION_MAX_PASSES` times in the
same nightly window. With defaults that's up to 1M rows per policy
per night — plenty of headroom even on a freshly-enabled DB with
months of bloat.

If the backlog STILL isn't drained after 20 passes, the next day's
run continues. No data ever gets stuck; it just takes longer to
clean up on the first few nights.

To accelerate first-run draining on a bloated DB, run the CLI a
few times in succession:

```bash
for i in 1 2 3 4 5; do npm run retention; done
```

## Observability

Every nightly run emits one structured log line:

```json
{
  "msg": "retention pass complete",
  "durationMs": 4523,
  "executions":    { "successDeleted": 1247, "failedDeleted": 38, "total": 1285, "passes": 1 },
  "refreshTokens": { "deleted": 89,  "passes": 1 },
  "history":       { "deleted": 0,   "passes": 1 },
  "errors":        0
}
```

The same run is also wrapped in an OTel span (`retention.run`)
visible in Tempo / Grafana — useful for spotting when retention
suddenly takes 10× longer (usually means a query is now hitting a
missing index).

A handy Grafana panel to add to your overview dashboard:

```sql
-- Rows in executions, per status
SELECT status, count(*)::int AS n
  FROM executions
 GROUP BY status
 ORDER BY n DESC
```

Watch the trend — successful retention is "executions grows, then
plateaus at roughly (daily-volume × retention-window)".

## Cascade behaviour

When a row is deleted from `executions`, its `node_states` rows
are cascaded by the FK (`ON DELETE CASCADE` from migration 010).
You don't need a separate `node_states` policy. Verify the FK is
in place on legacy DBs:

```sql
SELECT conname FROM pg_constraint
 WHERE conrelid = 'node_states'::regclass
   AND confrelid = 'executions'::regclass;
```

`node_states_execution_id_fkey` (or similar) should be listed.

## What's NOT retained automatically

These items grow but are user-driven; deletion is explicit:

- `graphs` (workflows) — soft-deleted via the UI; the row stays
  with `deleted_at` set. Operator can hard-delete via SQL if disk
  pressure ever shows up.
- `archived_graphs` (snapshots) — user-managed by design.
- `memories` with `namespace = 'kv'` — user data.
- `users`, `workspaces`, `configs`, `agents`, `triggers` —
  active resources; deletion is admin-driven.

The JSONL event log (`backend/logs/node-events.log`) is a single
shared file with append-only writes. It's not subject to
retention; rotate it via `logrotate` or equivalent at the OS
level.

## File map

| File | Role |
|------|------|
| `backend/src/retention/policies.js` | Per-table SQL pruners |
| `backend/src/retention/runner.js`   | Schedule + runAll + env config |
| `backend/src/cli/retention.js`      | `npm run retention` one-off |
| `backend/src/worker.js`             | Boots + stops the schedule |
| `backend/test/retention.test.js`    | Policy unit tests |

## Planned follow-ups

- **Per-workspace retention windows** — admins setting their own
  policy in the workspace settings UI. Foundation is in place; just
  needs a `workspace_settings` table and a join in the policies.
- **Audit-log retention** — when the audit log lands (separate
  production-readiness item), add a matching policy here.
