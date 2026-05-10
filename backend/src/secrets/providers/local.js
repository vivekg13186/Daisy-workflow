// Local KMS provider — no cloud dependency.
//
// What it is:
//   A drop-in stand-in for AWS / GCP KMS that lets the codebase keep
//   one code path for envelope encryption. The "KEK" is just a
//   32-byte key derived from CONFIG_SECRET (same source as the
//   pre-envelope crypto), and DEKs are wrapped using AES-256-GCM with
//   that KEK.
//
// What it is NOT:
//   A security upgrade by itself. The KEK still lives in process
//   memory after being derived from an env var. The threat model is
//   the same as today's single-CONFIG_SECRET scheme.
//
//   The point of running this provider in dev is purely architectural:
//   the storage shape, the API surface, and the rotation primitives
//   are all the same as in production. When the prod deployment flips
//   KMS_PROVIDER=aws, no app code changes — only the wrapped-DEK bytes
//   start being meaningful only to AWS KMS.
//
// Wrapped-DEK format (base64-decoded):
//
//     [version:1][iv:12][tag:16][ciphertext:32]
//
//   - version byte = 0x01 (room to evolve without breaking old rows)
//   - iv is per-DEK random
//   - ciphertext is AES-256-GCM(plaintextDek, key=KEK, iv=iv) with
//     `tag` as the authentication tag
//
// kekId reported as `local:CONFIG_SECRET` so audit logs can
// distinguish local from real KMS at a glance.

import crypto from "node:crypto";
import { log } from "../../utils/logger.js";

const ALGO    = "aes-256-gcm";
const IV_LEN  = 12;
const TAG_LEN = 16;
const DEK_LEN = 32;     // 256-bit AES DEK
const VERSION = 0x01;

let _kek = null;
let _warned = false;

function getKek() {
  if (_kek) return _kek;
  const secret = process.env.CONFIG_SECRET || "";
  if (!secret) {
    if (!_warned) {
      log.warn(
        "[kms:local] CONFIG_SECRET is not set — using a built-in dev KEK. " +
        "Set CONFIG_SECRET=<long-random-string> in any non-toy deployment, " +
        "or switch KMS_PROVIDER=aws for real HSM-backed key custody.",
      );
      _warned = true;
    }
    _kek = crypto.createHash("sha256")
      .update("dag-engine:dev-fallback-config-secret")
      .digest();
  } else {
    _kek = crypto.createHash("sha256").update(secret).digest();
  }
  return _kek;
}

export function create() {
  // Touch the KEK eagerly so any "no CONFIG_SECRET" warning fires at
  // boot, not at the first config write.
  getKek();
  return {
    id:    "local",
    kekId: "local:CONFIG_SECRET",

    async generateDataKey() {
      const plaintextDek = crypto.randomBytes(DEK_LEN);
      const wrappedDek   = wrap(plaintextDek);
      return {
        plaintextDek,
        wrappedDek,
        kekId: "local:CONFIG_SECRET",
      };
    },

    async decrypt(wrappedDek, _kekId) {
      // _kekId is informational here — the wrapped blob carries
      // everything we need (single global KEK in local mode).
      return unwrap(Buffer.isBuffer(wrappedDek) ? wrappedDek : Buffer.from(wrappedDek));
    },
  };
}

function wrap(plaintextDek) {
  const iv     = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, getKek(), iv);
  const ct     = Buffer.concat([cipher.update(plaintextDek), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION]), iv, tag, ct]);
}

function unwrap(blob) {
  if (blob.length < 1 + IV_LEN + TAG_LEN + DEK_LEN) {
    throw new Error("[kms:local] wrapped DEK is too short");
  }
  const version = blob[0];
  if (version !== VERSION) {
    throw new Error(`[kms:local] unsupported wrapped-DEK version ${version}`);
  }
  const iv  = blob.subarray(1, 1 + IV_LEN);
  const tag = blob.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
  const ct  = blob.subarray(1 + IV_LEN + TAG_LEN);
  const dec = crypto.createDecipheriv(ALGO, getKek(), iv);
  dec.setAuthTag(tag);
  return Buffer.concat([dec.update(ct), dec.final()]);
}
