-- Envelope encryption for configs (KMS-style).
--
-- Background:
--   v1 (the existing scheme): every secret field in `configs.data` is
--   AES-256-GCM encrypted with a single key derived from the
--   CONFIG_SECRET env var. One leaked CONFIG_SECRET decrypts every row.
--
--   v2 (this migration): per-row Data Encryption Key (DEK). Each row
--   generates a fresh 256-bit DEK that AES-encrypts that row's secret
--   fields. The DEK is then wrapped (encrypted) by a Key Encryption
--   Key (KEK) supplied by a pluggable provider:
--     - "local" provider: KEK derived from CONFIG_SECRET (dev default,
--       same threat model as today but the right shape).
--     - "aws"   provider: KEK lives in AWS KMS, never leaves the HSM.
--     - "gcp"   provider: same idea, GCP Cloud KMS (future).
--
--   The wrapped DEK is stored alongside the ciphertext under
--   data.__crypto.dek. The KEK identifier (e.g. an AWS KMS key ARN) is
--   ALSO duplicated into a top-level column so we can answer
--   "which rows are still on the old key after rotation?" with a SQL
--   filter instead of unpacking JSONB on every row.
--
-- Migration strategy:
--   - Existing rows keep encryption_version = 1 and continue to read
--     via the legacy CONFIG_SECRET path until they're edited or
--     re-encrypted via POST /configs/:id/rotate.
--   - New writes always land as v2.
--   - No data is moved by this migration — the read path is
--     version-aware. Lazy migration on next save / explicit rotation.

ALTER TABLE configs
  ADD COLUMN IF NOT EXISTS encryption_version SMALLINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS kek_id             TEXT;

-- Index for "which rows are still on a given KEK" queries (rotation
-- planning, audit reports). Partial because most rows once migrated
-- will share the same KEK; we mainly want it for the legacy/v1 case
-- and for cross-checking after a KEK swap.
CREATE INDEX IF NOT EXISTS idx_configs_kek_id ON configs (kek_id)
  WHERE kek_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_configs_encryption_version
  ON configs (encryption_version);

COMMENT ON COLUMN configs.encryption_version IS
  '1 = legacy single-key (CONFIG_SECRET); 2 = envelope (per-row DEK wrapped by KEK)';
COMMENT ON COLUMN configs.kek_id IS
  'Identifier of the KEK that wrapped this row DEK. Provider-specific (AWS KMS ARN, local:CONFIG_SECRET, etc). Null for v1 rows.';
