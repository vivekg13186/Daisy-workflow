# Configs encryption (KMS envelope)

How Daisy stores and rotates the secret fields inside `configs.data` —
SMTP passwords, database credentials, AI provider API keys, and any
field a user marks `secret` on a generic config.

If you just want it to work in dev: do nothing. The default
`KMS_PROVIDER=local` derives a key from `CONFIG_SECRET` and you're
already running. Read this page when you're going to production or
need to rotate a secret.

## The model

Each config row has its own freshly generated **Data Encryption Key**
(DEK). The DEK encrypts every secret field in that row using
AES-256-GCM. The DEK itself never sits in the database in plaintext —
it's wrapped (encrypted) by a **Key Encryption Key** (KEK) supplied by
a pluggable provider. The wrapped DEK is stored alongside the
ciphertext.

```
configs row
├─ data
│   ├─ host: "smtp.gmail.com"            ← plaintext, non-secret
│   ├─ password: { __enc, v2, v: "…" }   ← AES-GCM(plaintext, DEK)
│   └─ __crypto:
│       ├─ v: 2
│       ├─ kek_id: "<provider-id>"
│       └─ dek: "<base64 wrapped DEK>"   ← KMS-wrapped(DEK, KEK)
├─ encryption_version: 2
└─ kek_id: "<provider-id>"
```

To read a config the engine asks the KMS provider to unwrap the DEK,
decrypts each field locally, then wipes the DEK from memory. One KMS
round-trip per row, regardless of how many secret fields it contains.

## Providers

Selected via `KMS_PROVIDER`. The contract is identical across
providers — only the wrapped-DEK bytes are interpreted differently.

### `local` (default)

The KEK is a 32-byte hash of `CONFIG_SECRET`. Wrapping uses the same
AES-256-GCM primitive as the per-field encryption, so the entire
crypto path is in-process and dependency-free.

Threat model: same as the pre-envelope single-key scheme —
`CONFIG_SECRET` plus the database is enough to decrypt everything.
The point of running the local provider is that the **shape** is
already envelope-encryption: when you flip to AWS KMS, no app code
changes.

### `aws`

The KEK lives in AWS KMS, backed by an HSM. KEK material never leaves
AWS — the SDK only sees `Encrypt`, `Decrypt`, and `GenerateDataKey`
operations.

Setup:

```bash
npm install @aws-sdk/client-kms
```

```bash
KMS_PROVIDER=aws
KMS_KEY_ID=arn:aws:kms:us-east-1:123456789012:key/abcd-1234
AWS_REGION=us-east-1
```

The IAM role attached to your runtime needs three actions on the key:

```json
{
  "Effect":   "Allow",
  "Action":   ["kms:GenerateDataKey", "kms:Decrypt", "kms:DescribeKey"],
  "Resource": "arn:aws:kms:us-east-1:123456789012:key/abcd-1234"
}
```

Every call passes `EncryptionContext = { app: "daisy-dag" }` so a
leaked wrapped DEK can't be replayed by another app sharing the role.

## Migration from v1 (legacy single-key)

Existing rows from before this feature carry `encryption_version = 1`
and live on the legacy `CONFIG_SECRET` path. They keep decrypting
indefinitely — there is no breaking change.

Three ways to upgrade a row to v2:

1. **Edit it through the UI** — saving the row triggers a fresh DEK
   and lays down v2 data.
2. **POST `/configs/:id/rotate`** — re-encrypts in place without the
   user having to re-enter the secret value. Returns
   `{ from_version, to_version }`.
3. **Bulk:** the lazy approach is fine for most teams. If you want to
   force-migrate everything at once, iterate the v1 rows:

   ```sql
   SELECT id FROM configs WHERE encryption_version = 1;
   ```

   …and call rotate on each.

You can stop carrying `CONFIG_SECRET` entirely once `SELECT count(*)
FROM configs WHERE encryption_version = 1` is zero **and** you've
deployed at least one revision with `KMS_PROVIDER=aws`.

## Rotation

There are two distinct rotation operations and they have very
different costs.

### KEK rotation (cheap)

Done in the cloud console, not in Daisy. AWS KMS supports automatic
annual rotation — same key alias, new internal version. Existing
wrapped DEKs are still decryptable because KMS knows the version
mapping. New writes pick up the new KEK version automatically. You
don't have to touch any ciphertext.

### DEK rotation (per-row)

When you suspect a specific config's DEK might be compromised, hit
the rotate endpoint:

```bash
curl -X POST http://localhost:3000/configs/<id>/rotate
```

Response:

```json
{
  "id": "abc-123",
  "rotated": true,
  "from_version": 2,
  "to_version": 2,
  "kek_id": "arn:aws:kms:us-east-1:…"
}
```

This unwraps the existing DEK, generates a new DEK via KMS, and
re-encrypts every secret field in the row. One KMS write call, one
SQL update.

## Audit trail

Every KMS operation is structured-logged at INFO level:

```json
{ "msg": "kms op", "op": "Decrypt", "provider": "aws",
  "kek": "arn:aws:kms:…", "trace_id": "...", "span_id": "..." }
```

The `trace_id` is automatically attached by the engine's logger
because envelope decryption happens inside the active workflow span.
That means the existing Grafana / Tempo dashboards already let you
ask "which trace decrypted this config" — no extra wiring.

For AWS specifically, every `KMS.Decrypt` call also lands in
CloudTrail with the IAM principal, source IP, and timestamp. That's
the audit log most compliance regimes actually want.

## What happens if KMS is down?

The worker fails the execution at `loadConfigsMap` time with a clear
error in the logs. Workflows that don't touch any configs aren't
affected. Queued jobs stay queued and retry once KMS comes back —
they don't get marked failed permanently.

For very latency-sensitive deployments you can extend
`backend/src/configs/loader.js` to cache decrypted DEKs across
executions for a short window (60s is typical). The hook is the
`getProvider()` factory in `secrets/kms.js`. The current default of
"refetch every execution" is the conservative choice.

## File map

| File | Role |
|------|------|
| `backend/src/configs/crypto.js` | AES-GCM helpers (v1 legacy + v2 envelope) |
| `backend/src/configs/registry.js` | `encryptSecrets` / `decryptSecrets` orchestration |
| `backend/src/configs/loader.js` | Per-execution decrypt-into-`ctx.config` |
| `backend/src/secrets/kms.js` | Provider dispatch + audit logging |
| `backend/src/secrets/providers/local.js` | Dev-mode KEK from `CONFIG_SECRET` |
| `backend/src/secrets/providers/aws.js` | AWS KMS via `@aws-sdk/client-kms` (lazy) |
| `backend/src/api/configs.js` | CRUD + `POST /:id/rotate` |
| `backend/migrations/013_configs_envelope.sql` | `encryption_version` + `kek_id` columns |
| `backend/test/configs-envelope.test.js` | Round-trip + rotation tests |
