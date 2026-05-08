-- Configs feature v2: typed configurations with grouped fields.
--
-- Old shape (migration 005) was a flat key -> JSON value with a `secret` flag,
-- meant for env-var-style scalars. We're upgrading to a typed grouped row
-- (one config = one connection / credential bundle, e.g. `prodDb`,
-- `mailServer`, `mqttBroker`) with a `type` discriminator that drives the
-- editor UI and validation.
--
-- Existing rows are preserved: each old `key` row becomes a `generic` config
-- whose `data` blob is the original `value` wrapped under the key:
--      { "value": <original value> }
-- The `secret` flag carries over so the API can still mask it.

-- Add new columns (nullable so the rewrite below works in stages).
ALTER TABLE configs
  ADD COLUMN IF NOT EXISTS name TEXT,
  ADD COLUMN IF NOT EXISTS type TEXT,
  ADD COLUMN IF NOT EXISTS data JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Backfill from the legacy columns. We tolerate the case where this
-- migration is re-run on a partly-migrated DB by only filling rows where
-- name/type are still NULL.
UPDATE configs
   SET name = key,
       type = 'generic',
       data = jsonb_build_object('value', value)
 WHERE name IS NULL
    OR type IS NULL;

-- Now lock in the constraints.
ALTER TABLE configs
  ALTER COLUMN name SET NOT NULL,
  ALTER COLUMN type SET NOT NULL;

-- The unique key on `key` is replaced by a unique index on `name`.
DROP INDEX IF EXISTS idx_configs_key;
ALTER TABLE configs DROP CONSTRAINT IF EXISTS configs_key_key;

-- Drop the legacy `key` and `value` columns once data has been folded in.
-- Anything still relying on them will fail loudly, which is what we want.
ALTER TABLE configs DROP COLUMN IF EXISTS key;
ALTER TABLE configs DROP COLUMN IF EXISTS value;

-- New uniqueness + lookup indexes.
CREATE UNIQUE INDEX IF NOT EXISTS idx_configs_name ON configs (name);
CREATE INDEX        IF NOT EXISTS idx_configs_type ON configs (type);
