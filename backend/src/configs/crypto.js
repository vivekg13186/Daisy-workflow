// AES-256-GCM helpers for config secret fields.
//
// Two encryption schemes coexist:
//
//   v1 (legacy): every secret field encrypted with one global key
//                derived from CONFIG_SECRET. Storage envelope:
//                  { __enc: true, v: "<base64 iv|tag|ciphertext>" }
//
//   v2 (envelope): per-row Data Encryption Key (DEK) wraps every
//                  secret field; the DEK itself is wrapped by a Key
//                  Encryption Key managed by a KMS provider (see
//                  secrets/kms.js). Storage envelope:
//                    { __enc: true, v2: true, v: "<base64 iv|tag|ciphertext>" }
//
//                  The wrapped DEK lives separately at
//                  data.__crypto.dek, paired with kek_id and version.
//
// Read path:
//   - decryptValue() handles v1 envelopes (legacy single-key path).
//   - decryptValueWithDek() handles v2 envelopes (caller has already
//     unwrapped the DEK via the KMS provider).
//
// Write path:
//   - encryptValueWithDek() always produces v2 envelopes. New writes
//     never produce v1.
//   - encryptValue() is preserved purely so older callers / tests that
//     don't yet know about envelope encryption still compile.

import crypto from "node:crypto";
import { log } from "../utils/logger.js";

const ALGO    = "aes-256-gcm";
const IV_LEN  = 12;   // GCM standard
const TAG_LEN = 16;

// ────────────────────────────────────────────────────────────────────
// v1 — legacy single-key path (read-only for new code).
// ────────────────────────────────────────────────────────────────────

let _legacyKey = null;
let _warned = false;

function getLegacyKey() {
  if (_legacyKey) return _legacyKey;
  const secret = process.env.CONFIG_SECRET || "";
  if (!secret) {
    if (!_warned) {
      log.warn(
        "CONFIG_SECRET is not set — falling back to a built-in dev key. " +
        "Set CONFIG_SECRET=<long-random-string> in production, or " +
        "switch KMS_PROVIDER=aws for KMS-backed envelope encryption.",
      );
      _warned = true;
    }
    _legacyKey = crypto.createHash("sha256")
      .update("dag-engine:dev-fallback-config-secret")
      .digest();
  } else {
    _legacyKey = crypto.createHash("sha256").update(secret).digest();
  }
  return _legacyKey;
}

/**
 * Encrypt a value using the legacy single-key scheme.
 *
 * KEPT ONLY FOR BACK-COMPAT — new code should use encryptValueWithDek.
 * Returns the v1 envelope shape.
 */
export function encryptValue(value) {
  if (value == null) return value;
  const plaintext = typeof value === "string" ? value : JSON.stringify(value);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, getLegacyKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob = Buffer.concat([iv, tag, enc]).toString("base64");
  return { __enc: true, v: blob };
}

/**
 * Decrypt a v1 envelope. Returns input unchanged if it isn't an
 * envelope (handles legacy plain values).
 */
export function decryptValue(envelope) {
  if (!isEncrypted(envelope)) return envelope;
  if (envelope.v2) {
    // Caller asked us to decrypt a v2 envelope through the v1 path —
    // they need to use decryptValueWithDek and pass the DEK.
    throw new Error(
      "decryptValue called on v2 envelope — use decryptValueWithDek with the row's DEK",
    );
  }
  const buf = Buffer.from(envelope.v, "base64");
  const iv  = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct  = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, getLegacyKey(), iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  try { return JSON.parse(dec); } catch { return dec; }
}

// ────────────────────────────────────────────────────────────────────
// v2 — envelope path (per-row DEK).
// ────────────────────────────────────────────────────────────────────

/**
 * Encrypt a value using a row-scoped DEK. Always produces a v2
 * envelope: `{ __enc: true, v2: true, v: "<base64 iv|tag|ciphertext>" }`.
 * The DEK is a Buffer the caller obtained from the KMS provider; we
 * don't generate or persist it here.
 */
export function encryptValueWithDek(value, dek) {
  if (value == null) return value;
  if (!Buffer.isBuffer(dek) || dek.length !== 32) {
    throw new Error("encryptValueWithDek: dek must be a 32-byte Buffer");
  }
  const plaintext = typeof value === "string" ? value : JSON.stringify(value);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, dek, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob = Buffer.concat([iv, tag, enc]).toString("base64");
  return { __enc: true, v2: true, v: blob };
}

/** Decrypt a v2 envelope using the row's plaintext DEK. */
export function decryptValueWithDek(envelope, dek) {
  if (!isEncrypted(envelope)) return envelope;
  if (!envelope.v2) {
    // Caller is on the v2 path but the field is a v1 envelope. Fall
    // through to the legacy key — handles rows that were partially
    // re-encrypted, or fields added before v2.
    return decryptValue(envelope);
  }
  if (!Buffer.isBuffer(dek) || dek.length !== 32) {
    throw new Error("decryptValueWithDek: dek must be a 32-byte Buffer");
  }
  const buf = Buffer.from(envelope.v, "base64");
  const iv  = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct  = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, dek, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  try { return JSON.parse(dec); } catch { return dec; }
}

// ────────────────────────────────────────────────────────────────────
// Helpers used by the registry.
// ────────────────────────────────────────────────────────────────────

/** True iff `v` is one of the encrypted-envelope shapes (v1 or v2). */
export function isEncrypted(v) {
  return !!(v && typeof v === "object" && v.__enc === true && typeof v.v === "string");
}

/** True iff `v` is specifically a v2 envelope (needs a DEK to decrypt). */
export function isV2Envelope(v) {
  return isEncrypted(v) && v.v2 === true;
}

/**
 * Read the per-row crypto block from a stored data object.
 * Returns null if the row is v1 (no envelope metadata).
 */
export function readCryptoBlock(data) {
  const c = data?.__crypto;
  if (!c) return null;
  if (typeof c.dek !== "string") return null;
  return {
    version:    c.v ?? 2,
    kekId:      c.kek_id || null,
    wrappedDek: Buffer.from(c.dek, "base64"),
  };
}

/** Write a crypto block onto a row in-place. */
export function writeCryptoBlock(data, { wrappedDek, kekId }) {
  data.__crypto = {
    v:      2,
    kek_id: kekId,
    dek:    Buffer.isBuffer(wrappedDek) ? wrappedDek.toString("base64") : wrappedDek,
  };
  return data;
}

/** Remove the crypto block (used when a row has no secrets left). */
export function removeCryptoBlock(data) {
  if (data && typeof data === "object") delete data.__crypto;
  return data;
}

/**
 * Best-effort wipe of a Buffer's contents. Won't help against a debugger
 * that grabs the buffer mid-operation, but keeps a plaintext DEK from
 * lingering in the heap any longer than necessary.
 */
export function wipeBuffer(buf) {
  if (Buffer.isBuffer(buf)) {
    try { buf.fill(0); } catch { /* fixed-size pools throw, ignore */ }
  }
}
