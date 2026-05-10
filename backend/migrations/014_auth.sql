-- Authentication, authorization, and multi-workspace foundation.
--
-- Three new tables:
--
--   • workspaces      — the tenancy unit. Every owned resource (graph,
--                       config, agent, execution, memory, trigger)
--                       belongs to exactly one workspace.
--
--   • users           — local accounts (email + bcrypt hash) AND
--                       OIDC-only accounts (oidc_subject set,
--                       password_hash NULL). Roles are admin / editor /
--                       viewer.
--
--   • refresh_tokens  — opaque random tokens (sha256 hashed at rest).
--                       Short access JWT + long refresh token, rotated
--                       on use. `rotated_to` chains successive
--                       refreshes; `revoked_at` lets logout / admin
--                       disable kill a session.
--
-- Plus workspace_id NOT NULL added to every owned resource.
--
-- Backfill behaviour:
--   This migration is non-destructive. If existing rows are present,
--   they're auto-assigned to a fixed-UUID "Default" workspace
--   (00000000-0000-0000-0000-000000000001). After the migration any
--   admin you create starts in that workspace and can see the legacy
--   data. On a truly fresh DB the backfill UPDATEs are no-ops.

-- ────────────────────────────────────────────────────────────────────
-- Workspaces  (created FIRST so we can FK against it from below)
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workspaces (
  id          UUID PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE workspaces IS
  'Tenancy unit. Every owned resource carries workspace_id NOT NULL.';

-- Seed the Default workspace with a known UUID. ON CONFLICT means
-- re-running the migration (or running it on a partially-migrated DB)
-- is a no-op.
INSERT INTO workspaces (id, name, slug)
VALUES ('00000000-0000-0000-0000-000000000001', 'Default', 'default')
ON CONFLICT (id) DO NOTHING;

-- ────────────────────────────────────────────────────────────────────
-- Users
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  password_hash   TEXT,
  role            TEXT NOT NULL DEFAULT 'editor',
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  status          TEXT NOT NULL DEFAULT 'active',
  oidc_subject    TEXT,
  display_name    TEXT,
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT users_role_chk
    CHECK (role IN ('admin', 'editor', 'viewer')),
  CONSTRAINT users_status_chk
    CHECK (status IN ('active', 'disabled'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower
  ON users (lower(email));
CREATE INDEX IF NOT EXISTS idx_users_workspace ON users (workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_oidc_subject
  ON users (oidc_subject) WHERE oidc_subject IS NOT NULL;

COMMENT ON TABLE users IS
  'Local accounts and OIDC accounts. password_hash NULL = OIDC-only.';

-- ────────────────────────────────────────────────────────────────────
-- Workspace membership (extra workspaces beyond users.workspace_id)
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workspace_members (
  user_id       UUID NOT NULL REFERENCES users(id)      ON DELETE CASCADE,
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role          TEXT NOT NULL DEFAULT 'editor',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (user_id, workspace_id),
  CONSTRAINT workspace_members_role_chk
    CHECK (role IN ('admin', 'editor', 'viewer'))
);
CREATE INDEX IF NOT EXISTS idx_workspace_members_workspace
  ON workspace_members (workspace_id);

-- ────────────────────────────────────────────────────────────────────
-- Refresh tokens
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          UUID PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL,
  user_agent  TEXT,
  ip          INET,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  rotated_to  UUID REFERENCES refresh_tokens(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user
  ON refresh_tokens (user_id, revoked_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_refresh_tokens_hash
  ON refresh_tokens (token_hash);

COMMENT ON TABLE refresh_tokens IS
  'Opaque refresh tokens. sha256(token) stored at rest. Rotated on use; revoked_at locks out compromised sessions.';

-- ────────────────────────────────────────────────────────────────────
-- workspace_id on every owned resource.
--
-- Strategy that survives both fresh + populated databases:
--   1. ADD COLUMN nullable, with a default pointing at the Default
--      workspace UUID. Existing rows are filled by the default.
--   2. Backfill is a no-op (defaults already populated everything).
--   3. Drop the DEFAULT (we don't want future inserts to silently
--      land in the Default workspace) and SET NOT NULL.
--
-- Why per-table blocks instead of a loop: keeps the migration purely
-- declarative SQL — any SQL client / migration tool can replay it
-- without a procedural extension.
-- ────────────────────────────────────────────────────────────────────

-- graphs
ALTER TABLE graphs
  ADD COLUMN IF NOT EXISTS workspace_id UUID
    DEFAULT '00000000-0000-0000-0000-000000000001'
    REFERENCES workspaces(id) ON DELETE RESTRICT;
UPDATE graphs SET workspace_id = '00000000-0000-0000-0000-000000000001'
  WHERE workspace_id IS NULL;
ALTER TABLE graphs
  ALTER COLUMN workspace_id DROP DEFAULT,
  ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_graphs_workspace ON graphs (workspace_id);

-- configs
ALTER TABLE configs
  ADD COLUMN IF NOT EXISTS workspace_id UUID
    DEFAULT '00000000-0000-0000-0000-000000000001'
    REFERENCES workspaces(id) ON DELETE RESTRICT;
UPDATE configs SET workspace_id = '00000000-0000-0000-0000-000000000001'
  WHERE workspace_id IS NULL;
ALTER TABLE configs
  ALTER COLUMN workspace_id DROP DEFAULT,
  ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_configs_workspace ON configs (workspace_id);

-- agents
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS workspace_id UUID
    DEFAULT '00000000-0000-0000-0000-000000000001'
    REFERENCES workspaces(id) ON DELETE RESTRICT;
UPDATE agents SET workspace_id = '00000000-0000-0000-0000-000000000001'
  WHERE workspace_id IS NULL;
ALTER TABLE agents
  ALTER COLUMN workspace_id DROP DEFAULT,
  ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agents_workspace ON agents (workspace_id);

-- executions
ALTER TABLE executions
  ADD COLUMN IF NOT EXISTS workspace_id UUID
    DEFAULT '00000000-0000-0000-0000-000000000001'
    REFERENCES workspaces(id) ON DELETE RESTRICT;
UPDATE executions SET workspace_id = '00000000-0000-0000-0000-000000000001'
  WHERE workspace_id IS NULL;
ALTER TABLE executions
  ALTER COLUMN workspace_id DROP DEFAULT,
  ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_executions_workspace ON executions (workspace_id);

-- memories
ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS workspace_id UUID
    DEFAULT '00000000-0000-0000-0000-000000000001'
    REFERENCES workspaces(id) ON DELETE RESTRICT;
UPDATE memories SET workspace_id = '00000000-0000-0000-0000-000000000001'
  WHERE workspace_id IS NULL;
ALTER TABLE memories
  ALTER COLUMN workspace_id DROP DEFAULT,
  ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memories_workspace ON memories (workspace_id);

-- triggers
ALTER TABLE triggers
  ADD COLUMN IF NOT EXISTS workspace_id UUID
    DEFAULT '00000000-0000-0000-0000-000000000001'
    REFERENCES workspaces(id) ON DELETE RESTRICT;
UPDATE triggers SET workspace_id = '00000000-0000-0000-0000-000000000001'
  WHERE workspace_id IS NULL;
ALTER TABLE triggers
  ALTER COLUMN workspace_id DROP DEFAULT,
  ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_triggers_workspace ON triggers (workspace_id);
