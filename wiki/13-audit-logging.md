# Audit logging

Security-relevant actions are recorded in a dedicated `audit_logs`
table — insert-only by convention, pruned by retention, queryable
through a dedicated admin page.

## What gets logged

| Action | When |
|--------|------|
| `auth.login`            | Local-account login (success + failed) |
| `auth.oidc.login`       | OIDC callback completed |
| `auth.logout`           | User clicked sign-out |
| `auth.refresh`          | Refresh failure (theft replay / invalid token) — successes aren't audited (too noisy; happens every 15 min per active session) |
| `user.create`           | Admin invited a new user |
| `user.update`           | Role / status / display name change (with before-after diff in metadata) |
| `user.password.reset`   | Admin set a user's password |
| `user.disable`          | Admin soft-deleted a user |
| `workspace.rename`      | Admin renamed the active workspace |
| `workspace.switch`      | User switched active workspace |
| `graph.create`          | Workflow created |
| `graph.update`          | Workflow edited |
| `graph.delete`          | Workflow soft-deleted |
| `graph.execute`         | Workflow run started via UI / API (NOT trigger-fired) |
| `config.create`         | Configuration created |
| `config.update`         | Configuration edited |
| `config.delete`         | Configuration removed |
| `config.rotate`         | Configuration secret rotated (KMS envelope) |
| `trigger.create`        | Trigger added |
| `trigger.update`        | Trigger edited (name / config / enabled) |
| `trigger.delete`        | Trigger removed |

Read-only operations (browse workflows, view executions) are **not**
audited — they'd add noise without security value.

## Row shape

```sql
SELECT * FROM audit_logs LIMIT 1;
```

```
id              uuid
workspace_id    uuid          (NULL for system-wide events)
actor_id        uuid          (FK → users; SET NULL on user delete)
actor_email     text          (denormalised — survives user deletion)
actor_role      text
action          text          ("user.create", "graph.update", ...)
resource_type   text          ("user", "graph", "config", "trigger", ...)
resource_id     uuid
resource_name   text          (denormalised display name, capped at 250 chars)
outcome         text          ('success' | 'failed' | 'denied')
metadata        jsonb         (action-specific payload — role-change deltas, etc.)
ip              inet
user_agent      text          (capped at 500 chars)
trace_id        text          (correlate with OTel trace if any)
created_at      timestamptz
```

The `actor_email` + `actor_role` columns are denormalised so the
log entry survives the user's deletion. Compliance audits regularly
need to know "what did this email do" months after offboarding.

## The audit page

Admins see a **Audit log** entry in the user menu (top-right
avatar → Audit log). Filters at the top:

- **Action prefix** — type `auth.` to see every auth event; `user.`
  for everything user-management.
- **Actor** — email or user-id; finds events by that person.
- **Outcome** — narrow to `failed` / `denied` to focus on incidents.

Pagination is cursor-based via the server's `nextBefore` token. Click
**Load more** at the bottom to fetch the next 100 rows.

The metadata column shows the JSONB blob inline for each row;
useful action-specific examples:

- `user.update` includes a `changes` diff: `{ role: { from: "editor", to: "admin" } }`.
- `auth.login` failures include a `reason`: `no-user` (email not in DB)
  or `bad-password`.
- `config.rotate` shows the `from_version` / `to_version` of the
  encryption envelope.

## Retention

Audit rows are pruned by the same nightly retention pass that
trims executions and conversation history. Default window is **365
days** — comfortable for SOC2 / "12 months minimum" compliance asks.
Override:

```bash
RETENTION_AUDIT_LOG_DAYS=730     # 2 years, e.g. HIPAA
```

The bounded LIMIT pattern means a freshly-enabled retention on a
year-old DB drains over a few nightly passes rather than locking
the table.

## Querying for forensics

Some SQL recipes for security investigations:

```sql
-- All failed logins in the last 24 hours
SELECT created_at, actor_email, ip, metadata->>'reason' AS reason
  FROM audit_logs
 WHERE action = 'auth.login' AND outcome = 'failed'
   AND created_at > NOW() - INTERVAL '24 hours'
 ORDER BY created_at DESC;

-- Who deleted what in the last week
SELECT created_at, actor_email, resource_type, resource_id, resource_name
  FROM audit_logs
 WHERE action LIKE '%.delete'
   AND created_at > NOW() - INTERVAL '7 days'
 ORDER BY created_at DESC;

-- All admin role changes
SELECT created_at, actor_email, resource_name AS target_user,
       metadata->'changes'->'role' AS role_change
  FROM audit_logs
 WHERE action = 'user.update'
   AND metadata->'changes' ? 'role'
 ORDER BY created_at DESC;

-- Config secret rotations (sensitive — verify the actor was who
-- you expect)
SELECT created_at, actor_email, resource_name,
       metadata->>'kek_id' AS kek_id
  FROM audit_logs
 WHERE action = 'config.rotate'
 ORDER BY created_at DESC;
```

## Trace correlation

Every audit row carries the OTel trace_id of the request that
produced it. From a row in the audit log you can jump straight to
the Tempo trace and see the full request lifecycle — exactly which
SQL ran, what HTTP calls fired, how long each took. Useful when
investigating "why did this audit row appear" without rebuilding the
request from scratch.

## Tamper resistance

The audit table is insert-only **by convention**, not by Postgres
constraint. A compromised admin with `psql` access can technically
modify or delete rows. Three mitigations to consider for higher
assurance:

1. **Backups** — PR 9's daily `pg_dump` captures the audit table
   too. Off-site copies in S3 (with object-lock or versioning) give
   you a write-once-read-many tamper-evident trail.

2. **WAL archiving** — Postgres WAL contains the full row-level
   change history. Stream WAL to immutable storage (S3 with
   object-lock) for point-in-time forensics.

3. **External log forwarding** — Pipe `audit_logs` INSERTs through
   a logical replication slot into an external SIEM (Splunk, Datadog,
   Elastic). The SIEM becomes the canonical store; the DB table is
   convenience-only.

The default (DB + backups + WAL) is sufficient for most "we run
this for our own team" deployments. Regulated industries should add
external forwarding.

## File map

| File | Role |
|------|------|
| `backend/migrations/016_audit_logs.sql` | table + indexes |
| `backend/src/audit/log.js` | `auditLog()` helper + `diff()` |
| `backend/src/api/audit.js` | admin-only read endpoint with filters + cursor pagination |
| `backend/src/api/{auth,users,workspaces,graphs,configs,triggers}.js` | call sites |
| `backend/src/retention/policies.js` | `pruneAuditLogs()` |
| `frontend/src/pages/AuditPage.vue` | browse + filter UI |
| `frontend/src/components/UserMenu.vue` | "Audit log" admin menu entry |
| `backend/test/audit.test.js` | helper round-trip tests |
