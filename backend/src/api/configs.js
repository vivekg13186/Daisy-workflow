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
  maskSecrets,
} from "../configs/registry.js";
import { isEncrypted } from "../configs/crypto.js";

const router = Router();

// Names share the same identifier rules we use for graph nodes — they're
// how a config is referenced from a DSL expression (${config.<name>.<key>}),
// so they need to be path-safe.
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

// ──────────────────────────────────────────────────────────────────────────
// Type registry — drives the frontend ConfigDesigner UI.
// ──────────────────────────────────────────────────────────────────────────
router.get("/types", (_req, res) => {
  res.json(listTypes());
});

// ──────────────────────────────────────────────────────────────────────────
// List — secrets masked.
// ──────────────────────────────────────────────────────────────────────────
router.get("/", async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, type, description, data, created_at, updated_at
       FROM configs
       ORDER BY name`
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
router.get("/:id", async (req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT * FROM configs WHERE id=$1", [req.params.id]);
    if (rows.length === 0) throw new NotFoundError("config");
    const row = rows[0];
    res.json({ ...row, data: maskSecrets(row.type, row.data) });
  } catch (e) { next(e); }
});

// ──────────────────────────────────────────────────────────────────────────
// Create
// ──────────────────────────────────────────────────────────────────────────
router.post("/", async (req, res, next) => {
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

    const stored = encryptSecrets(type, normalised);

    const id = uuid();
    try {
      await pool.query(
        `INSERT INTO configs (id, name, type, description, data)
         VALUES ($1,$2,$3,$4,$5)`,
        [id, name, type, description || "", JSON.stringify(stored)],
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
router.put("/:id", async (req, res, next) => {
  try {
    const { name, description, data } = req.body || {};

    const { rows } = await pool.query("SELECT * FROM configs WHERE id=$1", [req.params.id]);
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
      const stored = encryptSecrets(existing.type, normalised);
      params.push(JSON.stringify(stored)); sets.push(`data = $${params.length}::jsonb`);
    }
    if (sets.length === 0) return res.json({ id: req.params.id, updated: false });
    params.push(req.params.id);
    sets.push("updated_at = NOW()");
    try {
      await pool.query(
        `UPDATE configs SET ${sets.join(", ")} WHERE id = $${params.length}`, params,
      );
    } catch (e) {
      if (e.code === "23505") throw new ValidationError(`config name "${name}" already exists`);
      throw e;
    }
    res.json({ id: req.params.id, updated: true });
  } catch (e) { next(e); }
});

// ──────────────────────────────────────────────────────────────────────────
// Delete
// ──────────────────────────────────────────────────────────────────────────
router.delete("/:id", async (req, res, next) => {
  try {
    const { rowCount } = await pool.query("DELETE FROM configs WHERE id=$1", [req.params.id]);
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
