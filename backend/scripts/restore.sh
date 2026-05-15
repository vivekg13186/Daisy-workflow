#!/usr/bin/env bash
#
# Daisy-workflow Postgres restore script.
#
# Usage:
#
#   ./scripts/restore.sh <dump-path>
#   ./scripts/restore.sh s3://my-bucket/daisy/daisy-20260510T030000Z.dump.gz
#
# What it does:
#
#   1. Resolve the dump path (local file or s3:// URL).
#   2. Decompress / decrypt as needed (.gz / .gpg detected from filename).
#   3. Drop + recreate the target DB (gated by --force; default is
#      DRY-RUN that prints the commands it WOULD run).
#   4. pg_restore --clean --if-exists into the target.
#   5. Print row counts on key tables as a sanity check.
#
# Env:
#
#   DATABASE_URL                target — DEFAULTS TO A SCRATCH DB NAME
#                               (daisy_restore) so a bare invocation
#                               doesn't accidentally overwrite prod.
#                               To restore over the live DB, pass
#                               --target-database-url=... or set
#                               DATABASE_URL=postgres://...prod_db.
#   BACKUP_GPG_RECIPIENT        only used if dump is .gpg — script
#                               assumes a private key is in the
#                               operator's keyring.
#
# Quarterly restore drills should use a scratch DB. See
# wiki/09-backups.md for the documented procedure.

set -euo pipefail

DRY_RUN=true
TARGET_OVERRIDE=""
for arg in "$@"; do
  case "$arg" in
    --force) DRY_RUN=false ;;
    --target-database-url=*) TARGET_OVERRIDE="${arg#*=}" ;;
    --*) echo "unknown flag: $arg" >&2; exit 64 ;;
    *)   DUMP_INPUT="$arg" ;;
  esac
done

if [[ -z "${DUMP_INPUT:-}" ]]; then
  echo "Usage: $0 <dump-path-or-s3-url> [--force] [--target-database-url=URL]"
  exit 64
fi

# ────────────────────────────────────────────────────────────────────
# Defaults: scratch DB, not prod. Operators must opt into overwriting
# real data either via env or the explicit flag.
# ────────────────────────────────────────────────────────────────────

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$HERE/../.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$HERE/../.env"
  set +a
fi

# Derive scratch URL by replacing the database name in DATABASE_URL.
default_scratch_url() {
  local base="${DATABASE_URL:-postgres://localhost:5432/postgres}"
  # Strip the trailing /dbname.
  printf "%s/daisy_restore" "$(echo "$base" | sed -E 's#/[^/?]+(\?.*)?$##')"
}

TARGET_URL="${TARGET_OVERRIDE:-$(default_scratch_url)}"
echo "[restore] target = $TARGET_URL"
$DRY_RUN && echo "[restore] DRY-RUN: pass --force to actually run the destructive steps below."

# ────────────────────────────────────────────────────────────────────
# Resolve dump file — pull from S3 if needed.
# ────────────────────────────────────────────────────────────────────

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

if [[ "$DUMP_INPUT" =~ ^s3:// ]]; then
  if ! command -v aws >/dev/null 2>&1; then
    echo "[restore] aws CLI required for s3:// paths" >&2; exit 3
  fi
  LOCAL_PATH="$WORKDIR/$(basename "$DUMP_INPUT")"
  echo "[restore] downloading $DUMP_INPUT"
  $DRY_RUN || aws s3 cp "$DUMP_INPUT" "$LOCAL_PATH"
else
  LOCAL_PATH="$DUMP_INPUT"
fi

# Decrypt + decompress in-place.
if [[ "$LOCAL_PATH" == *.gpg ]]; then
  echo "[restore] decrypting"
  $DRY_RUN || gpg --batch --yes --decrypt --output "${LOCAL_PATH%.gpg}" "$LOCAL_PATH"
  LOCAL_PATH="${LOCAL_PATH%.gpg}"
fi
if [[ "$LOCAL_PATH" == *.gz ]]; then
  echo "[restore] gunzipping"
  $DRY_RUN || gunzip -kf "$LOCAL_PATH"
  LOCAL_PATH="${LOCAL_PATH%.gz}"
fi

# ────────────────────────────────────────────────────────────────────
# Drop + recreate the target DB. This is the destructive bit; gated
# by --force. The two psql calls connect to the *server* (postgres
# DB) so we can drop the target DB without being connected to it.
# ────────────────────────────────────────────────────────────────────

# Strip "/dbname" off the target URL to get a "server" URL.
SERVER_URL="$(echo "$TARGET_URL" | sed -E 's#/[^/?]+(\?.*)?$##')"
TARGET_DB="$(basename "$(echo "$TARGET_URL" | sed -E 's#\?.*$##')")"
echo "[restore] server=$SERVER_URL db=$TARGET_DB"

run() {
  echo "  + $*"
  $DRY_RUN || "$@"
}

run psql "$SERVER_URL" -c "DROP DATABASE IF EXISTS $TARGET_DB"
run psql "$SERVER_URL" -c "CREATE DATABASE $TARGET_DB"

# ────────────────────────────────────────────────────────────────────
# pg_restore. `--clean --if-exists` tolerates objects that don't
# exist yet (because we just made the DB fresh). `--no-owner` lets
# us restore into a DB owned by a different user than the dump.
# ────────────────────────────────────────────────────────────────────

echo "[restore] pg_restore → $TARGET_URL"
run pg_restore --clean --if-exists --no-owner \
               --dbname="$TARGET_URL" "$LOCAL_PATH"

# ────────────────────────────────────────────────────────────────────
# Sanity check. Cheap row counts on every owned table — if a dump
# was truncated mid-write we'd see one of these as 0 when we expect
# >0. Operators eyeball this before considering the restore done.
# ────────────────────────────────────────────────────────────────────

if ! $DRY_RUN; then
  echo "[restore] sanity counts:"
  psql "$TARGET_URL" -c "
    SELECT 'workspaces'    AS table, count(*)::int FROM workspaces
    UNION ALL SELECT 'users',          count(*)::int FROM users
    UNION ALL SELECT 'graphs',         count(*)::int FROM graphs
    UNION ALL SELECT 'configs',        count(*)::int FROM configs
    UNION ALL SELECT 'agents',         count(*)::int FROM agents
    UNION ALL SELECT 'triggers',       count(*)::int FROM triggers
    UNION ALL SELECT 'executions',     count(*)::int FROM executions
    UNION ALL SELECT 'node_states',    count(*)::int FROM node_states
    UNION ALL SELECT 'memories',       count(*)::int FROM memories
    UNION ALL SELECT 'refresh_tokens', count(*)::int FROM refresh_tokens
    ORDER BY 1;
  "
fi

echo "[restore] done"
