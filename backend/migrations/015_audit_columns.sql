-- Audit columns — "who last modified this row".
--
-- Adds `updated_by` (UUID, nullable, FK → users) to every owned
-- resource table. The API stamps it from req.user.id on every
-- INSERT and UPDATE; list/get queries LEFT JOIN users to surface
-- the modifier's email in the response.
--
-- Why nullable: existing rows (created before this migration ran)
-- have no recorded modifier. They'll show "—" in the UI until
-- they're next edited. Also: triggers fire executions without a
-- user, so triggered-from-trigger paths can legitimately leave it
-- NULL.
--
-- Why ON DELETE SET NULL: removing a user shouldn't cascade-delete
-- the workflows they edited. Their attribution just becomes "—".

ALTER TABLE graphs
  ADD COLUMN IF NOT EXISTS updated_by UUID
    REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_graphs_updated_by ON graphs (updated_by);

ALTER TABLE configs
  ADD COLUMN IF NOT EXISTS updated_by UUID
    REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_configs_updated_by ON configs (updated_by);

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS updated_by UUID
    REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_agents_updated_by ON agents (updated_by);

ALTER TABLE triggers
  ADD COLUMN IF NOT EXISTS updated_by UUID
    REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_triggers_updated_by ON triggers (updated_by);
