#!/usr/bin/env bash
#
# Daisy-DAG Postgres backup script.
#
# Produces a custom-format pg_dump file, optionally gzipped, optionally
# uploaded to S3, and optionally encrypted with gpg before upload.
# Custom format (`-Fc`) is the right default: it's compressed,
# selective-restore friendly via pg_restore, and produces one file
# instead of a directory.
#
# Usage:
#
#   ./scripts/backup.sh
#
# Reads from env (or backend/.env via dotenv-style sourcing):
#
#   DATABASE_URL                postgres://user:pass@host:port/db    (required)
#   BACKUP_DIR                  /var/backups/daisy                   (default)
#   BACKUP_S3_BUCKET            s3://my-bucket/daisy/                (optional)
#   BACKUP_GPG_RECIPIENT        admin@example.com                    (optional, gpg key id)
#   BACKUP_RETENTION_LOCAL      14                                   (keep N most recent)
#   BACKUP_GZIP                 true                                  (default true)
#
# Exit codes:
#   0  success
#   1  configuration error (no DATABASE_URL)
#   2  pg_dump failure
#   3  upload failure (after a successful local dump — file is still on disk)
#
# What this script does NOT do:
#   • Locking against concurrent backups — operators schedule via cron;
#     two nightly runs colliding is a non-issue at typical cadence.
#   • Verify the dump round-trips. Use scripts/restore.sh to a scratch
#     database; quarterly drill is documented in wiki/09-backups.md.
#   • Back up Redis or the .env file — see runbook for why.

set -euo pipefail

# ────────────────────────────────────────────────────────────────────
# Config (env-driven; bare defaults are dev-friendly)
# ────────────────────────────────────────────────────────────────────

# Source backend/.env if it exists, so the script Just Works after
# `cd backend && ./scripts/backup.sh` without exporting env vars by hand.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$HERE/../.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$HERE/../.env"
  set +a
fi

DATABASE_URL="${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/daisy}"
BACKUP_S3_BUCKET="${BACKUP_S3_BUCKET:-}"
BACKUP_GPG_RECIPIENT="${BACKUP_GPG_RECIPIENT:-}"
BACKUP_RETENTION_LOCAL="${BACKUP_RETENTION_LOCAL:-14}"
BACKUP_GZIP="${BACKUP_GZIP:-true}"

mkdir -p "$BACKUP_DIR"

# ────────────────────────────────────────────────────────────────────
# Dump
#
# `-Fc` = custom format (binary, compressed). The default plain-SQL
# format is ~10x larger and slower to restore on a busy DB.
#
# Timestamp uses ISO-flavoured UTC + sortable: a directory of
# backups sorts chronologically on `ls`.
# ────────────────────────────────────────────────────────────────────

TS="$(date -u +'%Y%m%dT%H%M%SZ')"
DUMP_PATH="$BACKUP_DIR/daisy-${TS}.dump"

echo "[backup] dumping → $DUMP_PATH"
if ! pg_dump --format=custom --no-owner --no-privileges \
             --dbname="$DATABASE_URL" \
             --file="$DUMP_PATH"; then
  echo "[backup] pg_dump failed" >&2
  exit 2
fi
echo "[backup] dump complete ($(du -h "$DUMP_PATH" | cut -f1))"

# ────────────────────────────────────────────────────────────────────
# Optional compress
#
# pg_dump custom-format is already compressed (-Z 5 by default), so
# additional gzip yields maybe 5-10% more — useful for slow upload
# links, skippable on local disk. Default true to match user habit.
# ────────────────────────────────────────────────────────────────────

if [[ "${BACKUP_GZIP,,}" == "true" || "${BACKUP_GZIP,,}" == "1" ]]; then
  echo "[backup] gzipping…"
  gzip -f "$DUMP_PATH"
  DUMP_PATH="${DUMP_PATH}.gz"
fi

# ────────────────────────────────────────────────────────────────────
# Optional gpg encrypt
#
# pg_dump output contains JSONB and config rows. Configs encrypted at
# rest are *still* encrypted in the dump (we ship encrypted-at-rest
# data), but the rest of the DB (graphs, agents, audit data) is in
# plaintext. If your S3 bucket is shared or sketchily ACL'd, encrypt.
# ────────────────────────────────────────────────────────────────────

if [[ -n "$BACKUP_GPG_RECIPIENT" ]]; then
  echo "[backup] encrypting for $BACKUP_GPG_RECIPIENT…"
  gpg --batch --yes --recipient "$BACKUP_GPG_RECIPIENT" --encrypt "$DUMP_PATH"
  rm -f "$DUMP_PATH"
  DUMP_PATH="${DUMP_PATH}.gpg"
fi

# ────────────────────────────────────────────────────────────────────
# Optional S3 upload
# ────────────────────────────────────────────────────────────────────

if [[ -n "$BACKUP_S3_BUCKET" ]]; then
  if ! command -v aws >/dev/null 2>&1; then
    echo "[backup] BACKUP_S3_BUCKET set but aws CLI not found" >&2
    exit 3
  fi
  TARGET="${BACKUP_S3_BUCKET%/}/$(basename "$DUMP_PATH")"
  echo "[backup] uploading → $TARGET"
  if ! aws s3 cp "$DUMP_PATH" "$TARGET"; then
    echo "[backup] S3 upload failed; local copy retained at $DUMP_PATH" >&2
    exit 3
  fi
  echo "[backup] uploaded"
fi

# ────────────────────────────────────────────────────────────────────
# Local retention — keep N most recent .dump* files.
# ────────────────────────────────────────────────────────────────────

if [[ "$BACKUP_RETENTION_LOCAL" -gt 0 ]]; then
  echo "[backup] pruning local copies → keep last $BACKUP_RETENTION_LOCAL"
  # ls -1t: newest first.
  # tail -n +N: drop the first (N-1) entries.
  cd "$BACKUP_DIR"
  # shellcheck disable=SC2010
  ls -1t daisy-*.dump* 2>/dev/null \
    | tail -n "+$(( BACKUP_RETENTION_LOCAL + 1 ))" \
    | xargs -r rm -f
fi

echo "[backup] done"
