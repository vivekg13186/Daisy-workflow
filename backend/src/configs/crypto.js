// AES-256-GCM helpers for config secret fields.
//
// Why GCM: authenticated encryption, so any tampering with the ciphertext
// surfaces as a decryption error rather than silently producing garbage.
//
// Key sourcing:
//   - CONFIG_SECRET env var, hashed to 32 bytes via SHA-256.
//   - If unset, a deterministic "dev" key is derived from a constant. We log
//     a one-time warning at startup so prod deployments can't accidentally
//     ship without a real secret.
//
// Storage shape — encrypted values are stored as objects so we can tell them
// apart from plain strings during read back:
//
//     { __enc: true, v: "<base64 iv|tag|ciphertext>" }

import crypto from "node:crypto";
import { log } from "../utils/logger.js";

const ALGO = "aes-256-gcm";
const IV_LEN  = 12;   // GCM standard
const TAG_LEN = 16;

let _key = null;
let _warned = false;

function getKey() {
  if (_key) return _key;
  const secret = process.env.CONFIG_SECRET || "";
  if (!secret) {
    if (!_warned) {
      log.warn(
        "CONFIG_SECRET is not set — falling back to a built-in dev key. " +
        "Set CONFIG_SECRET=<long-random-string> in production.",
      );
      _warned = true;
    }
    _key = crypto.createHash("sha256")
      .update("dag-engine:dev-fallback-config-secret")
      .digest();
  } else {
    _key = crypto.createHash("sha256").update(secret).digest();
  }
  return _key;
}

/**
 * Encrypt a UTF-8 string, return the storage envelope `{ __enc, v }`.
 * Non-string values are JSON-encoded first so we can round-trip booleans /
 * numbers / objects (rare for credential fields, but supported).
 */
export function encryptValue(value) {
  if (value == null) return value;
  const plaintext = typeof value === "string" ? value : JSON.stringify(value);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // iv | tag | ciphertext  → one base64 blob
  const blob = Buffer.concat([iv, tag, enc]).toString("base64");
  return { __enc: true, v: blob };
}

/**
 * Decrypt an envelope produced by encryptValue. If the envelope shape is
 * unrecognised, the input is returned unchanged — that handles legacy plain
 * values smoothly.
 */
export function decryptValue(envelope) {
  if (!envelope || typeof envelope !== "object" || envelope.__enc !== true) {
    return envelope;
  }
  const buf = Buffer.from(envelope.v, "base64");
  const iv  = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct  = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  // Try to JSON-parse; if that fails just return the string.
  try { return JSON.parse(dec); } catch { return dec; }
}

/** Quick test helper for the type registry — true iff the value is an envelope. */
export function isEncrypted(v) {
  return !!(v && typeof v === "object" && v.__enc === true && typeof v.v === "string");
}
