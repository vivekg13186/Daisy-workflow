-- Plugin registry — Phase 3.
--
-- Three changes:
--   1. PRIMARY KEY moves from (name) to (name, version) so multiple
--      versions of the same plugin can coexist. Workflows can pin to
--      a specific version via "name@1.2.0"; otherwise they resolve
--      against the row marked is_default=true.
--   2. Marketplace metadata: manifest_sha256 + catalog_entry_url +
--      homepage + category + tags. Filled in when a plugin is
--      installed from a catalog; null for hand-installed plugins.
--   3. A partial unique index guarantees at most one is_default=true
--      row per name, so the "default version" lookup is unambiguous.
--
-- Pre-existing rows (one-version-per-name from migration 018) are
-- carried forward with is_default=true.

-- 1) PK
ALTER TABLE plugins DROP CONSTRAINT IF EXISTS plugins_pkey;
ALTER TABLE plugins ADD PRIMARY KEY (name, version);

-- 2) New columns
ALTER TABLE plugins
  ADD COLUMN IF NOT EXISTS is_default        BOOLEAN     NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS manifest_sha256   TEXT,
  ADD COLUMN IF NOT EXISTS catalog_entry_url TEXT,
  ADD COLUMN IF NOT EXISTS homepage          TEXT,
  ADD COLUMN IF NOT EXISTS category          TEXT,
  ADD COLUMN IF NOT EXISTS tags              JSONB       NOT NULL DEFAULT '[]'::jsonb;

-- Existing rows: mark every row as default (since there's only one
-- version per name at this point — this is a no-op but explicit).
UPDATE plugins SET is_default = true WHERE is_default IS NULL;

-- 3) At most one is_default per name. Partial unique index — only
-- applies to rows where is_default = true so non-default versions
-- can coexist freely.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_plugins_default_per_name
  ON plugins (name) WHERE is_default = true;

CREATE INDEX IF NOT EXISTS idx_plugins_category
  ON plugins (category) WHERE category IS NOT NULL;

COMMENT ON COLUMN plugins.is_default IS
  'True for the version that resolves when a workflow uses "name" without "@version".';
COMMENT ON COLUMN plugins.manifest_sha256 IS
  'SHA-256 of the manifest body at install time. Catalog installs carry the catalog''s declared checksum here; mismatches block install.';
COMMENT ON COLUMN plugins.catalog_entry_url IS
  'Source URL of the catalog entry (for upgrade flows). Null when installed by direct endpoint.';
