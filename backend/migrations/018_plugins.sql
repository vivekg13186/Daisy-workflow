-- Plugin registry — moved from "globbed at boot" to DB-backed so
-- plugins can be installed/disabled/upgraded at runtime, including
-- plugins that live in their own containers.
--
-- One row per plugin NAME (Phase 1). Multi-version side-by-side is
-- a Phase 3 addition; for now installing a new version replaces the
-- existing row.
--
-- `source` carries provenance:
--   'core'      — shipped in backend/src/plugins/builtin/.
--                 Upserted on every worker boot, never deleted.
--   'local'     — operator dropped under plugins-extra/ or installed
--                 via the install-plugin CLI pointing at a private
--                 endpoint. Survives boot.
--   'marketplace:<id>' — installed from the public catalog. Carries
--                 the catalog id so upgrades can target the right
--                 source.
--
-- `transport_kind`:
--   'in-process' — the worker imports and calls the plugin in-proc
--                 (the historical path, kept for core + plugins-extra).
--   'http'       — the worker calls plugin.endpoint over HTTP with
--                 the standardised /execute payload.
--
-- `status` is updated by a periodic healthcheck against HTTP plugins
-- (/readyz). In-process plugins are always healthy.

CREATE TABLE IF NOT EXISTS plugins (
  name              TEXT        PRIMARY KEY,
  version           TEXT        NOT NULL,
  manifest          JSONB       NOT NULL,

  transport_kind    TEXT        NOT NULL,
  endpoint          TEXT,                              -- non-null when transport_kind='http'

  enabled           BOOLEAN     NOT NULL DEFAULT true,
  source            TEXT        NOT NULL,

  status            TEXT        NOT NULL DEFAULT 'unknown',
  last_health_at    TIMESTAMPTZ,
  last_error        TEXT,                              -- last health/dispatch error

  installed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT plugins_transport_chk
    CHECK (transport_kind IN ('in-process', 'http')),
  CONSTRAINT plugins_endpoint_chk
    CHECK ( (transport_kind = 'http' AND endpoint IS NOT NULL)
         OR (transport_kind = 'in-process') ),
  CONSTRAINT plugins_status_chk
    CHECK (status IN ('healthy', 'degraded', 'down', 'unknown'))
);

CREATE INDEX IF NOT EXISTS idx_plugins_enabled
  ON plugins (enabled) WHERE enabled = true;
CREATE INDEX IF NOT EXISTS idx_plugins_source
  ON plugins (source);
