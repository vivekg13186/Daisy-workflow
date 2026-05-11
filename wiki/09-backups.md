# Backups

How to back up and restore Daisy. Postgres is the single source of
truth; everything else is either rebuildable (Redis, Tempo) or lives
outside Daisy (`.env`, KMS keys). This page covers three deployment
shapes — laptop, single VM with Docker, managed Postgres — and the
restore procedure that turns "we have backups" into "we recovered."

## What needs backing up

| Item | Where it lives | Backup strategy |
|------|----------------|------------------|
| **Postgres** (graphs, configs, agents, executions, memories, users, refresh tokens, workspaces) | the DB | `pg_dump` daily + optional WAL archiving for PITR |
| **`backend/.env`** (`JWT_SECRET`, `CONFIG_SECRET`, `KMS_KEY_ID`) | filesystem | secrets manager / password vault — *separate from the dumps* |
| **AWS KMS key** (if `KMS_PROVIDER=aws`) | AWS KMS | covered by AWS — enable multi-region key for DR |
| Redis | in-memory + RDB on disk | **no backup needed** — losing it forfeits in-flight queue state, which `reapOrphanedExecutions` cleans up on next worker boot |
| Tempo traces | tempo-data volume | **no backup needed** — traces are debugging data, not historical record |
| JSONL event log (`backend/logs/`) | filesystem | optional; the same events are reconstructable from the DB |

The single most-overlooked item is `backend/.env`. If you lose it,
every `configs` row with encrypted-at-rest data becomes useless — the
ciphertexts are intact in the dump, but without `CONFIG_SECRET` (and,
if you're using envelope encryption, the matching KMS key) you can't
decrypt them. Treat `.env` like a password: store it in your team's
secrets manager / password vault, *separate* from the database dumps.

## The scripts

Two scripts ship with the backend:

```
backend/scripts/backup.sh    # pg_dump + gzip + optional S3 upload
backend/scripts/restore.sh   # pg_restore from local path or s3://
```

Both read from `backend/.env` (or any env you set in your shell).
Configurable via:

```bash
DATABASE_URL=postgres://dag:dag@localhost:5432/dag_engine
BACKUP_DIR=/var/backups/daisy
BACKUP_RETENTION_LOCAL=14           # keep 14 most-recent locally
BACKUP_GZIP=true
BACKUP_S3_BUCKET=s3://my-bucket/daisy/   # optional
BACKUP_GPG_RECIPIENT=admin@example.com   # optional, encrypts before upload
```

Run a backup manually:

```bash
cd backend && ./scripts/backup.sh
# → /var/backups/daisy/daisy-20260510T030000Z.dump.gz
```

The restore script defaults to a **scratch DB** (`daisy_restore`)
and a **dry-run** mode. You opt into destructive behaviour:

```bash
# Show what it would do, against a scratch DB (safe to run anywhere):
./scripts/restore.sh /var/backups/daisy/daisy-20260510T030000Z.dump.gz

# Actually do it, into the scratch DB:
./scripts/restore.sh /var/backups/daisy/daisy-20260510T030000Z.dump.gz --force

# Restore over a specific DB (e.g. recovering prod after disaster):
./scripts/restore.sh /backup.dump.gz --force \
  --target-database-url=postgres://dag:dag@prod-db:5432/dag_engine
```

The restore prints row counts for every owned table at the end so
you can eyeball whether the dump was complete.

## Scenario A: laptop / single dev machine

What you need: a cron entry and somewhere to copy the dumps offsite.

```bash
# crontab -e
30 2 * * *  cd /path/to/daisy-dag/backend && ./scripts/backup.sh >> /var/log/daisy-backup.log 2>&1
```

For "offsite copy" the cheapest pragmatic answer is a synced folder
(Dropbox / iCloud / Google Drive) pointing at `BACKUP_DIR`. Or
configure `BACKUP_S3_BUCKET` and let `aws s3 cp` push to S3.

RPO with daily dumps alone: up to 24 hours of data loss. For dev /
solo workflows that's usually fine.

## Scenario B: single VM with Docker Compose

Use the bundled overlay to run nightly backups as a sidecar:

```bash
cd /path/to/daisy-dag
docker compose -f docker-compose.yml -f docker-compose.backup.yml up -d
```

Adds one container, `daisy-backup`, that runs `backup.sh` on
`BACKUP_CRON` (default `0 3 * * *`). Dumps land in a named volume
(`daisy_backups`) and, if `BACKUP_S3_BUCKET` is set in the host
env, get pushed to S3 too. The image is `postgres:16-alpine` so
`pg_dump` matches the server version.

To tighten RPO below 24 hours, enable WAL archiving on Postgres
itself (separate setup — `postgresql.conf` + a tool like `wal-g` or
`pgbackrest`). At that point an outage at 14:23 can be recovered to
14:22 instead of "last night's dump." This is mostly Postgres
operator territory, not Daisy-specific; the docs at
`https://postgresql.org/docs/current/continuous-archiving.html`
cover it well.

## Scenario C: managed Postgres (RDS / Cloud SQL / Supabase / Aiven)

Configure the platform's snapshot retention to N days (most default
to 7; bump to 30+). Don't layer your own daily dumps on top — you'd
be paying twice for storage.

You should still run `scripts/backup.sh` periodically — but to a
*different* location (e.g. a different AWS account's S3 bucket).
The platform's snapshots protect you from infrastructure failure;
an independent dump protects you from a compromised platform
account or accidental delete-the-instance.

```bash
# Weekly sanity-dump to a second account, just in case.
0 4 * * 0  ./scripts/backup.sh   # BACKUP_S3_BUCKET pointing at the DR bucket
```

## The actual deliverable: restore drills

Backups you don't test aren't backups. Schedule a **quarterly drill**:

1. Pick the most recent nightly backup.
2. Spin up a scratch Postgres (Docker is fine — `docker run -d --rm -p 5433:5432 -e POSTGRES_PASSWORD=test postgres:16`).
3. Run `./scripts/restore.sh <dump-path> --force --target-database-url=postgres://postgres:test@localhost:5433/daisy_restore`.
4. Verify the sanity counts the script prints look plausible.
5. Optionally: point a Daisy worker at the scratch DB and run a known workflow end-to-end.
6. Document: who ran it, when, what version of Daisy, time-to-restore, any surprises.
7. Drop the scratch container.

Time-to-restore is the metric that matters. If your last drill took
45 minutes, that's your real RTO. If you've never done one, your
RTO is "indeterminate, possibly never" — which isn't a number you
can put in a status report.

## Beyond Postgres

**`backend/.env`** — back this up to your team's password manager
(1Password, Bitwarden, Vaultwarden, etc.) as a single secret entry.
Update the entry whenever you rotate `JWT_SECRET` or `CONFIG_SECRET`.

**KMS key (if you're using envelope encryption)** — AWS / GCP keep
the key material durable for you. The risk is *accidental
deletion*: AWS KMS keys have a 7-30 day pending-deletion window,
but if you sail past that, every `encryption_version = 2` config
in Daisy is irrecoverable. Mitigations:

- Set the KMS deletion window to the maximum (30 days).
- Enable multi-region replication for the KMS key.
- Tag the key so a cleanup script can't pick it up by accident.
- Document the key ARN in your password manager next to `.env`.

**Redis** — really don't bother. Losing it means BullMQ loses the
queue snapshot; workers reap orphan-running executions on next
boot and mark them failed. The cost is a few in-flight runs, not
data loss in the source-of-truth sense.

**Tempo traces** — same: debugging data, not historical record.
The Postgres dump already includes `executions.context._otel.trace_id`
so you can correlate post-restore.

## File map

| File | Role |
|------|------|
| `backend/scripts/backup.sh` | nightly `pg_dump` + gzip + optional S3/gpg |
| `backend/scripts/restore.sh` | drop+recreate+`pg_restore` with sanity counts |
| `docker-compose.backup.yml` | sidecar that runs `backup.sh` on cron |
| `backend/.env.example` | `BACKUP_*` env defaults |
