-- Audit log — security-relevant "who did what when".
--
-- Conventions:
--   • Insert-only by convention. The API never UPDATEs / DELETEs rows
--     here. A retention policy (see retention/policies.js followup)
--     prunes rows older than the workspace's audit window.
--
--   • Actor is denormalised on top of the FK so the row survives the
--     user's deletion. Compliance audits care about "what did this
--     email do" months after the user was offboarded.
--
--   • workspace_id is nullable: global events (system boot, OIDC
--     callbacks before a user is matched) don't have a workspace yet.
--     The audit page's per-workspace filter still works — it queries
--     `WHERE workspace_id = $1 OR workspace_id IS NULL` when the
--     caller is admin and wants the full picture.
--
--   • metadata holds the action's shape — request body excerpts,
--     role-change deltas, outcomes of last-admin protection, etc.
--     JSONB keeps it queryable for ad-hoc forensics.

CREATE TABLE IF NOT EXISTS audit_logs (
  id              UUID        PRIMARY KEY,
  workspace_id    UUID,                                         -- nullable; system events
  actor_id        UUID                                                   -- the user who acted
                    REFERENCES users(id) ON DELETE SET NULL,
  actor_email     TEXT,                                         -- denormalised — survives deletion
  actor_role      TEXT,                                         -- ditto

  action          TEXT        NOT NULL,                         -- dotted-string, e.g. "user.create"
  resource_type   TEXT,                                         -- "user", "graph", "config", …
  resource_id     UUID,                                         -- affected row's id (when applicable)
  resource_name   TEXT,                                         -- denormalised display name

  outcome         TEXT        NOT NULL DEFAULT 'success',
  metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,

  ip              INET,
  user_agent      TEXT,
  trace_id        TEXT,                                          -- correlate with OTel trace

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT audit_logs_outcome_chk
    CHECK (outcome IN ('success', 'failed', 'denied'))
);

-- Query patterns expected:
--   1. Browse per workspace, newest-first.
--   2. Filter by actor.
--   3. Filter by action name (e.g. all logins).
--   4. Time-range scans for compliance reports.

CREATE INDEX IF NOT EXISTS idx_audit_logs_workspace_created
  ON audit_logs (workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_created
  ON audit_logs (actor_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_action_created
  ON audit_logs (action, created_at DESC);

COMMENT ON TABLE audit_logs IS
  'Security-relevant action log. Append-only by convention. Pruned by retention policy.';
