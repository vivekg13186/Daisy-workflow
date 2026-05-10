// Typed configurations API.
//
// A config row carries an external-system connection or credential bundle:
//
//     { id, name, type, description, data, created_at, updated_at }
//
// `type` selects the schema (database / mail.smtp / mail.imap / mqtt /
// generic) and `data` is the typed blob. Secret fields inside `data` are
// stored encrypted on disk (see configs/crypto.js); the API only ever
// returns "***" in their place. Encryption is opaque to clients — they
// PUT/POST plaintext, the server encrypts before insert.
//
// Endpoints:
//
//     GET    /configs/types     → registry for the editor UI
//     GET    /configs           → list (secrets masked)
//     GET    /configs/:id       → single row (secrets masked)
//     POST   /configs           → create
//     PUT    /configs/:id       → partial update (omit a secret field to keep its existing value)
//     DELETE /configs/:id       → delete

import { Router } from "express";
import { v4 as uuid } from "uuid";
import { pool } from "../db/pool.js";
import { ValidationError, NotFoundError } from "../utils/errors.js";
import {
  TYPES,
  listTypes,
  getType,
  validateAndNormalize,
  encryptSecrets,
  decryptSecrets,
  maskSecrets,
} from "../configs/registry.js";
import { requireUser, requireRole } from "../middleware/auth.js";

const router = Router();

// Auth model:
//   • Reads (list/get/types)     — admin + editor (editor needs them
//                                   to wire configs into graph nodes;
//                                   viewer doesn't edit so omitted).
//   • Writes (create/update/rotate/delete) — admin only. Configs hold
//                                   credentials; only an admin should
//                                   be able to create or rotate them.
//   • Workspace scoping          — every query carries
//                                   workspace_id = req.user.workspaceId.
router.use(requireUser);

// Names share the same identifier rules we use for graph nodes — they're
// how a config is referenced from a DSL expression (${config.<name>.<key>}),
// so they need to be path-safe.
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

// ──────────────────────────────────────────────────────────────────────────
// Type registry — drives the frontend ConfigDesigner UI.
// ──────────────────────────────────────────────────────────────────────────
router.get("/types", requireRole("admin", "editor"), (_req, res) => {
  res.json(listTypes());
});

// ──────────────────────────────────────────────────────────────────────────
// List — secrets masked.
// ──────────────────────────────────────────────────────────────────────────
router.get("/", requireRole("admin", "editor"), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, type, description, data, created_at, updated_at
       FROM configs
       WHERE workspace_id = $1
       ORDER BY name`,
      [req.user.workspaceId],
    );
    res.json(rows.map(r => ({
      ...r,
      data: maskSecrets(r.type, r.data),
    })));
  } catch (e) { next(e); }
});

// ──────────────────────────────────────────────────────────────────────────
// Get one — secrets masked. Use update flow to "rotate" a secret.
// ──────────────────────────────────────────────────────────────────────────
router.get("/:id", requireRole("admin", "editor"), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM configs WHERE id=$1 AND workspace_id=$2",
      [req.params.id, req.user.workspaceId],
    );
    if (rows.length === 0) throw new NotFoundError("config");
    const row = rows[0];
    res.json({ ...row, data: maskSecrets(row.type, row.data) });
  } catch (e) { next(e); }
});

// ──────────────────────────────────────────────────────────────────────────
// Create
// ──────────────────────────────────────────────────────────────────────────
router.post("/", requireRole("admin"), async (req, res, next) => {
  try {
    const { name, type, description = "", data = {} } = req.body || {};
    if (!name) throw new ValidationError("name required");
    if (!NAME_RE.test(name)) {
      throw new ValidationError(`invalid name: "${name}" — use letters, digits, _, - (must start with a letter or _)`);
    }
    if (!TYPES[type]) throw new ValidationError(`unknown type: "${type}"`);

    const normalised = validateAndNormalize(type, stripMaskedSecrets(type, data));
    // Carry the freeform "this key is secret" marker through validation if
    // present (validateAndNormalize for generic returns the data as-is).
    if (TYPES[type].freeform && data?.__secret) normalised.__secret = data.__secret;

    // Async because envelope encryption may go through a remote KMS.
    const { data: stored, encryption_version, kek_id } =
      await encryptSecrets(type, normalised);

    const id = uuid();
    try {
      await pool.query(
        `INSERT INTO configs (id, name, type, description, data, encryption_version, kek_id, workspace_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, name, type, description || "", JSON.stringify(stored), encryption_version, kek_id, req.user.workspaceId],
      );
    } catch (e) {
      if (e.code === "23505") throw new ValidationError(`config name "${name}" already exists`);
      throw e;
    }
    res.status(201).json({ id, name });
  } catch (e) { next(e); }
});

// ──────────────────────────────────────────────────────────────────────────
// Update (partial)
//
// Sending data fields is "merge over the existing row" — fields you don't
// include keep their stored value. Sending the literal "***" for a secret
// field means "keep the existing secret". Sending any other string for a
// secret field rotates it.
// ──────────────────────────────────────────────────────────────────────────
router.put("/:id", requireRole("admin"), async (req, res, next) => {
  try {
    const { name, description, data } = req.body || {};

    const { rows } = await pool.query(
      "SELECT * FROM configs WHERE id=$1 AND workspace_id=$2",
      [req.params.id, req.user.workspaceId],
    );
    if (rows.length === 0) throw new NotFoundError("config");
    const existing = rows[0];

    if (name !== undefined && name !== existing.name && !NAME_RE.test(name)) {
      throw new ValidationError(`invalid name: "${name}"`);
    }

    const sets = [], params = [];
    if (name !== undefined && name !== existing.name) {
      params.push(name); sets.push(`name = $${params.length}`);
    }
    if (description !== undefined) {
      params.push(description); sets.push(`description = $${params.length}`);
    }
    if (data !== undefined) {
      // Merge: incoming partial → existing → validate → re-encrypt.
      const merged = mergeData(existing.type, existing.data, data);
      const normalised = validateAndNormalize(existing.type, merged);
      if (TYPES[existing.type].freeform) {
        const incomingSecret = data?.__secret || existing.data?.__secret || {};
        if (incomingSecret && Object.keys(incomingSecret).length) {
          normalised.__secret = incomingSecret;
        }
      }
      const { data: stored, encryption_version, kek_id } =
        await encryptSecrets(existing.type, normalised);
      params.push(JSON.stringify(stored));         sets.push(`data = $${params.length}::jsonb`);
      params.push(encryption_version);             sets.push(`encryption_version = $${params.length}`);
      params.push(kek_id);                         sets.push(`kek_id = $${params.length}`);
    }
    if (sets.length === 0) return res.json({ id: req.params.id, updated: false });
    params.push(req.params.id);
    const idIdx = params.length;
    params.push(req.user.workspaceId);
    const wsIdx = params.length;
    sets.push("updated_at = NOW()");
    try {
      await pool.query(
        `UPDATE configs SET ${sets.join(", ")} WHERE id = $${idIdx} AND workspace_id = $${wsIdx}`,
        params,
      );
    } catch (e) {
      if (e.code === "23505") throw new ValidationError(`config name "${name}" already exists`);
      throw e;
    }
    res.json({ id: req.params.id, updated: true });
  } catch (e) { next(e); }
});

// ──────────────────────────────────────────────────────────────────────────
// Rotate — re-encrypt this row with a fresh DEK.
//
// What it does:
//   1. Decrypts the row's current secret fields (legacy v1 or v2).
//   2. Calls KMS.GenerateDataKey for a brand-new DEK.
//   3. Re-encrypts every secret field with the new DEK and writes back.
//
// Use cases:
//   • Suspected DEK leak → rotate just that row, no global key change.
//   • Periodic per-row rotation policy (cron / on-demand from UI).
//   • Migrate a legacy v1 row to v2 without the user having to
//     re-enter the secret value.
//
// The KEK in KMS is NOT rotated by this call — that's a KMS-side
// operation and doesn't require touching any ciphertext (KMS handles
// version mapping internally; on AWS, automatic annual KEK rotation
// is a one-checkbox setting).
// ──────────────────────────────────────────────────────────────────────────
router.post("/:id/rotate", requireRole("admin"), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM configs WHERE id=$1 AND workspace_id=$2",
      [req.params.id, req.user.workspaceId],
    );
    if (rows.length === 0) throw new NotFoundError("config");
    const existing = rows[0];

    // Decrypt to plaintext using whatever scheme the row is currently on.
    const plaintext = await decryptSecrets(existing.type, existing.data || {});
    // The freeform __secret marker survives in `existing.data` separately
    // — re-attach it so encryptSecrets knows which keys to encrypt.
    if (TYPES[existing.type].freeform && existing.data?.__secret) {
      plaintext.__secret = existing.data.__secret;
    }

    // Re-encrypt with a fresh DEK.
    const { data: stored, encryption_version, kek_id } =
      await encryptSecrets(existing.type, plaintext);

    await pool.query(
      `UPDATE configs
          SET data = $2::jsonb,
              encryption_version = $3,
              kek_id = $4,
              updated_at = NOW()
        WHERE id = $1 AND workspace_id = $5`,
      [existing.id, JSON.stringify(stored), encryption_version, kek_id, req.user.workspaceId],
    );
    res.json({
      id: existing.id,
      rotated: true,
      from_version: existing.encryption_version,
      to_version:   encryption_version,
      kek_id,
    });
  } catch (e) { next(e); }
});

// ──────────────────────────────────────────────────────────────────────────
// Delete
// ──────────────────────────────────────────────────────────────────────────
router.delete("/:id", requireRole("admin"), async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(
      "DELETE FROM configs WHERE id=$1 AND workspace_id=$2",
      [req.params.id, req.user.workspaceId],
    );
    if (rowCount === 0) throw new NotFoundError("config");
    res.status(200).json({ ok: true, id: req.params.id, deleted: "config" });
  } catch (e) { next(e); }
});

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

/** Strip the "***" sentinel sent back from list/get responses so it doesn't
 *  overwrite real ciphertext. Also re-attaches existing ciphertext if the
 *  caller is creating from a copied-and-edited list response. */
function stripMaskedSecrets(type, data) {
  const out = { ...(data || {}) };
  for (const k of Object.keys(out)) {
    if (out[k] === "***") delete out[k];
  }
  return out;
}

/** Merge a PATCH-style partial onto the existing stored row. Secret fields
 *  whose incoming value is "***" or undefined are taken from the stored
 *  envelope (preserving the encrypted ciphertext). Anything else replaces. */
function mergeData(type, existing = {}, patch = {}) {
  const def = getType(type);
  const out = { ...existing };
  for (const [k, v] of Object.entries(patch)) {
    if (v === "***") continue;             // preserve existing secret
    if (k === "__secret") continue;        // handled separately
    out[k] = v;
  }
  // For typed configs, ensure secret fields that were omitted keep their
  // ciphertext rather than being wiped.
  if (!def.freeform) {
    for (const f of def.fields) {
      if (f.secret && (patch[f.name] === undefined || patch[f.name] === "***")) {
        if (existing[f.name] !== undefined) out[f.name] = existing[f.name];
      }
    }
  }
  return out;
}

export default router;
