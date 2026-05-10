# Authentication & authorization

How Daisy authenticates users, issues sessions, and gates access to
graphs / configs / agents / executions / memories.

> **Status:** PR 1 (foundation) is landed — schema, login/refresh/logout
> endpoints, middleware, bootstrap CLI. PRs 2–4 add workspace
> filtering, frontend login, and admin UI. The backend is ready to
> talk to via curl after PR 1; the browser app gets re-enabled in PR 3.

## The model

**Identity** lives in `users`. Each user has one *primary* workspace
(`users.workspace_id`) and may belong to additional workspaces via
`workspace_members`. Three roles exist: `admin`, `editor`, `viewer`.
Local accounts (email + password) and OIDC accounts coexist in the
same table — `password_hash` is null for OIDC-only users.

**Sessions** are split into two tokens. A short-lived **access JWT**
(15 min) signed with `JWT_SECRET` carries `{ sub, email, role, ws }`
in its payload. A long-lived **opaque refresh token** (30 days) is a
random 256-bit string, stored at rest as `sha256(token)` only, sent
to the client as an httpOnly cookie scoped to `/auth`. The refresh
token rotates on every use — `/auth/refresh` issues a fresh one and
revokes the old one with a `rotated_to` chain pointer.

**Theft replay** is detected at refresh time: if a presented token
points to a `rotated_to` row, every active token for that user is
revoked.

**Tenancy** is enforced by `workspace_id NOT NULL` on every owned
table (graphs, configs, agents, executions, memories, triggers).
Even if a middleware bug ever lets a request through, the database
column protects you.

## Bootstrap a fresh deployment

After `npm run migrate` lands `014_auth.sql`, the database has zero
users — no one can log in. There are two ways to seed the first admin.

### Option A: CLI (recommended)

```bash
cd backend
npm run create-admin -- \
  --email   admin@example.com \
  --password '<long-random-password>' \
  --workspace 'Default' \
  --name 'Admin'
```

Prints `{ ok: true, action: "created", userId, workspaceId, ... }`.

The CLI refuses to add an admin if any user already exists, unless
you pass `--force`. That guard prevents accidental escalation if the
command is re-run by mistake.

### Option B: env-driven (CI/CD friendly)

Set these env vars on the worker process. On boot, if the DB has zero
users, a single admin gets created:

```bash
BOOTSTRAP_ADMIN_AUTOCREATE=true
BOOTSTRAP_ADMIN_EMAIL=admin@example.com
BOOTSTRAP_ADMIN_PASSWORD=<long-random>
BOOTSTRAP_WORKSPACE_NAME=Default     # optional
```

After the first boot, **remove** `BOOTSTRAP_ADMIN_PASSWORD` from your
deploy config. Leaving the password in env after seeding is
unnecessary risk — anyone with process-listing rights on the host
can read it.

## Logging in (until the frontend lands)

```bash
# 1. Login
curl -i -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"<password>"}' \
  -c /tmp/daisy.cookies

# Response:
# {
#   "accessToken": "eyJhbGc...",
#   "user": { "id":"...", "email":"...", "role":"admin",
#             "workspaceId":"...", "status":"active" }
# }

# 2. Use the access token on protected endpoints (after PR 2)
curl -H 'Authorization: Bearer eyJhbGc...' \
     http://localhost:3000/graphs

# 3. Refresh when the access token expires
curl -X POST http://localhost:3000/auth/refresh \
     -b /tmp/daisy.cookies -c /tmp/daisy.cookies

# 4. Logout
curl -X POST http://localhost:3000/auth/logout \
     -b /tmp/daisy.cookies
```

The browser version of this flow lives in PR 3 — Pinia auth store +
axios interceptor + login page + route guards.

## Roles, in one paragraph

`admin` can do anything in their workspace, including managing users
and configs. `editor` can create and run graphs, read `${config.x}`
values resolved at runtime, but cannot CRUD the underlying configs.
`viewer` can read graphs and execution history but cannot run, edit,
or delete anything.

Roles are enforced at the route level via `requireRole(...allowed)`.
The full mapping lands in PR 2 along with workspace filtering.

## OIDC (optional)

When `OIDC_ISSUER_URL` is set, the login screen shows a "Sign in with
SSO" button alongside the email/password form. The OIDC callback
matches users by their `sub` claim (stored in `users.oidc_subject`)
or creates a new user record on first login, defaulting to
`role=editor` in the workspace named by `OIDC_DEFAULT_WORKSPACE`
(falls back to "Default").

```bash
OIDC_ISSUER_URL=https://accounts.google.com
OIDC_CLIENT_ID=your-client-id
OIDC_CLIENT_SECRET=your-secret
OIDC_REDIRECT_URI=http://localhost:3000/auth/oidc/callback
OIDC_BUTTON_LABEL=Sign in with Google      # optional
```

Local accounts always remain enabled — OIDC is *additional*, not
exclusive. An admin can promote OIDC users to higher roles via the
admin UI (PR 4).

## Token TTLs

Defaults: 15 min access, 30 days refresh. Override per-deployment
with `ACCESS_TOKEN_TTL` and `REFRESH_TOKEN_TTL` (any of `15m`, `1h`,
`30d`, etc.). Shorter access TTLs reduce the window an admin
disable takes effect — the next refresh will fail and the user is
locked out within `ACCESS_TOKEN_TTL` of the disable.

## Rotating `JWT_SECRET`

Changing `JWT_SECRET` invalidates every outstanding access token —
all users have to log in again. Refresh tokens still work because
they're opaque and DB-side. So a rotation procedure is:

1. Deploy with the new `JWT_SECRET`.
2. Wait `ACCESS_TOKEN_TTL` for outstanding access tokens to expire.
3. Existing browser sessions silently call `/auth/refresh`, get a
   new JWT signed with the new secret, and continue.

No re-login required for active users.

## File map

| File | Role |
|------|------|
| `backend/migrations/014_auth.sql` | Schema: workspaces, users, refresh_tokens, workspace_id NOT NULL on owned tables |
| `backend/src/auth/passwords.js` | bcrypt hash/verify + needsRehash |
| `backend/src/auth/tokens.js` | JWT sign/verify + refresh token rotation |
| `backend/src/middleware/auth.js` | `requireUser`, `requireRole(...)` |
| `backend/src/api/auth.js` | `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/me`, `/auth/config` |
| `backend/src/cli/createAdmin.js` | `npm run create-admin --` + `runIfRequested()` boot hook |
| `backend/test/auth.test.js` | Password + JWT round-trip tests |
