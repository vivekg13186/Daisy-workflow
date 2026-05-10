// Config type registry — defines the shape of each `type` of config row.
//
// A type schema looks like:
//
//   {
//     label: "Database",
//     description: "JDBC-style database connection",
//     fields: [
//       { name: "host", type: "string",  required: true,  description: "..." },
//       { name: "port", type: "number",  default: 5432 },
//       { name: "password", type: "string", secret: true },
//       ...
//     ],
//   }
//
// Field types: "string" | "number" | "boolean" | "select" (with `options`).
// Field flags:
//   - required  → reject create/update if missing
//   - secret    → encrypted at rest, masked in /configs list responses
//   - default   → applied at validate-time when the field is missing
//
// `generic` is a special escape hatch: any keys are accepted, and any field
// can be marked `secret` by the user via the editor UI.

import {
  decryptValue,
  isEncrypted,
  isV2Envelope,
  encryptValueWithDek,
  decryptValueWithDek,
  readCryptoBlock,
  writeCryptoBlock,
  removeCryptoBlock,
  wipeBuffer,
} from "./crypto.js";
import { generateDataKey, decryptDataKey } from "../secrets/kms.js";

export const TYPES = Object.freeze({
  database: {
    label: "Database",
    description: "Generic database connection (Postgres, MySQL, etc.)",
    fields: [
      { name: "engine",   type: "select", required: true,
        options: ["postgres", "mysql", "sqlite", "mssql", "oracle"],
        default: "postgres",
        description: "Database engine" },
      { name: "host",     type: "string",  required: true,  description: "Hostname or IP" },
      { name: "port",     type: "number",  description: "TCP port (default depends on engine)" },
      { name: "database", type: "string",  required: true,  description: "Schema / database name" },
      { name: "username", type: "string" },
      { name: "password", type: "string",  secret: true },
      { name: "ssl",      type: "boolean", default: false },
    ],
  },
  "mail.smtp": {
    label: "Mail (SMTP / outgoing)",
    description: "Outgoing SMTP server used by the email.send plugin",
    fields: [
      { name: "host",     type: "string",  required: true },
      { name: "port",     type: "number",  required: true, default: 587 },
      { name: "secure",   type: "boolean", default: false, description: "Use TLS (true for port 465)" },
      { name: "username", type: "string" },
      { name: "password", type: "string",  secret: true },
      { name: "from",     type: "string",  description: "Default From: address" },
    ],
  },
  "mail.imap": {
    label: "Mail (IMAP / incoming)",
    description: "Incoming IMAP server used by the email trigger",
    fields: [
      { name: "host",     type: "string",  required: true },
      { name: "port",     type: "number",  required: true, default: 993 },
      { name: "tls",      type: "boolean", default: true },
      { name: "username", type: "string",  required: true },
      { name: "password", type: "string",  secret: true,  required: true },
      { name: "folder",   type: "string",  default: "INBOX" },
    ],
  },
  mqtt: {
    label: "MQTT broker",
    description: "MQTT broker connection used by the MQTT trigger",
    fields: [
      { name: "url",      type: "string", required: true,
        description: "Broker URL, e.g. mqtt://broker.local:1883 or mqtts://…:8883" },
      { name: "clientId", type: "string" },
      { name: "username", type: "string" },
      { name: "password", type: "string", secret: true },
    ],
  },
  "ai.provider": {
    label: "AI provider",
    description:
      "API credentials for an LLM provider (Anthropic / OpenAI / Groq / etc). " +
      "Referenced by the `agent` plugin via a stored agent's config name.",
    fields: [
      { name: "provider", type: "select", required: true,
        options: ["anthropic", "openai"],
        default: "anthropic",
        description: "Provider family. Drives the request shape (Anthropic Messages vs OpenAI Chat Completions)." },
      { name: "apiKey",   type: "string", required: true, secret: true,
        description: "API key. Encrypted at rest." },
      { name: "model",    type: "string", required: true,
        description: "Model id (e.g. claude-haiku-4-5-20251001 or gpt-4o-mini)." },
      { name: "baseUrl",  type: "string",
        description: "Optional override for the API endpoint. Defaults to the provider's standard URL." },
    ],
  },
  generic: {
    label: "Generic (key/value)",
    description: "Freeform key/value bag — for things that don't fit a specific type. " +
                 "Each key can optionally be marked secret.",
    // No declared fields — UI shows a freeform key/value editor and the
    // user picks which rows are secret.
    fields: [],
    freeform: true,
  },
});

/** List the types in a UI-friendly array. */
export function listTypes() {
  return Object.entries(TYPES).map(([type, def]) => ({
    type,
    label: def.label,
    description: def.description,
    fields: def.fields,
    freeform: !!def.freeform,
  }));
}

/** Get the type definition or throw a friendly error. */
export function getType(type) {
  const def = TYPES[type];
  if (!def) throw new Error(`Unknown config type: ${type}`);
  return def;
}

/**
 * Validate a `data` blob against its type. Returns a normalised copy with
 * defaults applied. Throws on the first violation (missing required, wrong
 * scalar type, bad enum value).
 *
 * For freeform types, `data` is returned as-is — the only constraint is that
 * keys be valid identifiers (caller enforces this elsewhere if it matters).
 */
export function validateAndNormalize(type, data) {
  const def = getType(type);
  if (def.freeform) {
    return { ...(data || {}) };
  }
  const out = {};
  const input = data || {};
  for (const f of def.fields) {
    let v = input[f.name];
    if (v === undefined || v === null || v === "") {
      if (f.default !== undefined) v = f.default;
    }
    if ((v === undefined || v === null || v === "") && f.required) {
      throw new Error(`Field "${f.name}" is required for ${type}`);
    }
    if (v !== undefined && v !== null && v !== "") {
      v = coerce(v, f);
      if (f.type === "select" && !f.options.includes(v)) {
        throw new Error(`Field "${f.name}" must be one of ${f.options.join(", ")}`);
      }
    }
    if (v !== undefined) out[f.name] = v;
  }
  return out;
}

function coerce(v, field) {
  switch (field.type) {
    case "number":
      if (typeof v === "number") return v;
      if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) {
        return Number(v);
      }
      throw new Error(`Field "${field.name}" must be a number (got ${typeof v})`);
    case "boolean":
      if (typeof v === "boolean") return v;
      if (v === "true")  return true;
      if (v === "false") return false;
      throw new Error(`Field "${field.name}" must be a boolean (got ${typeof v})`);
    case "string":
    case "select":
      return String(v);
    default:
      return v;
  }
}

/**
 * Encrypt all secret fields in a normalised data object using
 * envelope encryption (v2). The function is async because the KMS
 * provider may be remote (AWS / GCP / etc).
 *
 * Behaviour:
 *   • Generates a fresh DEK via the KMS provider.
 *   • Re-encrypts every plaintext secret field with that DEK.
 *   • Already-encrypted v2 fields are KEPT (their ciphertext + the
 *     existing DEK still match) — this lets PATCH-style updates leave
 *     untouched secrets alone without burning a new KMS call.
 *   • If the row already has a v1 (legacy) envelope on a secret field,
 *     we lazily upgrade it: decrypt with the legacy key, re-encrypt
 *     with the new DEK. After the next save the row is fully v2.
 *   • If the row turns out to have no secret values at all, we don't
 *     generate a DEK at all — no KMS call, no __crypto block.
 *
 * Returns:
 *   { data, encryption_version, kek_id }
 *
 *   `data` is a new object you store as configs.data (JSONB).
 *   `encryption_version` is 1 if there were no secrets to encrypt
 *   (so we can keep the row at v1) or 2 if a DEK was issued.
 *   `kek_id` is non-null only at v2.
 */
export async function encryptSecrets(type, data) {
  const def = getType(type);
  const out = { ...(data || {}) };
  const secretFields = collectSecretFields(def, out);
  if (secretFields.length === 0) {
    // Nothing to encrypt — keep schema simple, no DEK needed.
    removeCryptoBlock(out);
    return { data: out, encryption_version: 1, kek_id: null };
  }

  // Reuse the existing DEK only if every secret field is already a
  // v2 envelope AND we have a wrapped DEK on the row. Otherwise we
  // need a fresh DEK — generating a new one is the safe default and
  // costs one KMS call.
  const existingCrypto = readCryptoBlock(out);
  const allV2 = secretFields.every(({ value }) => isV2Envelope(value));
  if (existingCrypto && allV2) {
    // No-op: every secret is already wrapped with the row's current
    // DEK. Just leave the row as-is.
    return {
      data: out,
      encryption_version: 2,
      kek_id: existingCrypto.kekId,
    };
  }

  const { plaintextDek, wrappedDek, kekId } = await generateDataKey();
  try {
    for (const { name, value } of secretFields) {
      let plain = value;
      // Lazy v1 → v2 upgrade.
      if (isEncrypted(plain) && !isV2Envelope(plain)) {
        plain = decryptValue(plain);
      }
      out[name] = encryptValueWithDek(plain, plaintextDek);
    }
    writeCryptoBlock(out, { wrappedDek, kekId });
    return { data: out, encryption_version: 2, kek_id: kekId };
  } finally {
    wipeBuffer(plaintextDek);
  }
}

/**
 * Decrypt all secret fields in a stored data object. Async because v2
 * rows need a KMS round-trip to unwrap the DEK; v1 rows still resolve
 * synchronously through the legacy key.
 *
 * Returns a new object with plaintext values; the original is left
 * untouched. Used by the engine + trigger manager when wiring configs
 * into ctx.config and into trigger drivers.
 */
export async function decryptSecrets(type, data) {
  const out = { ...(data || {}) };
  const cryptoBlock = readCryptoBlock(out);

  if (!cryptoBlock) {
    // v1 path: every encrypted field is independent, single legacy key.
    for (const k of Object.keys(out)) {
      if (isEncrypted(out[k])) out[k] = decryptValue(out[k]);
    }
    return out;
  }

  // v2 path: unwrap once, then decrypt each secret field with the DEK.
  const dek = await decryptDataKey(cryptoBlock.wrappedDek, cryptoBlock.kekId);
  try {
    for (const k of Object.keys(out)) {
      if (k === "__crypto") continue;
      if (isV2Envelope(out[k])) {
        out[k] = decryptValueWithDek(out[k], dek);
      } else if (isEncrypted(out[k])) {
        // Mixed-version row (e.g. mid-upgrade) — fall back to legacy.
        out[k] = decryptValue(out[k]);
      }
    }
    // The crypto block is internal — drop it from the plaintext map
    // we hand to the engine.
    delete out.__crypto;
    return out;
  } finally {
    wipeBuffer(dek);
  }
}

/** Walk the type schema and pick out every secret field that has
 *  a (potentially encrypted) value attached. Used by encryptSecrets. */
function collectSecretFields(def, data) {
  const out = [];
  if (def.freeform) {
    const secretMap = data?.__secret || {};
    for (const k of Object.keys(secretMap)) {
      if (data[k] === undefined || data[k] === null || data[k] === "") continue;
      out.push({ name: k, value: data[k] });
    }
    return out;
  }
  for (const f of def.fields) {
    if (!f.secret) continue;
    const v = data[f.name];
    if (v === undefined || v === null || v === "") continue;
    out.push({ name: f.name, value: v });
  }
  return out;
}

/**
 * Mask all secret fields with a sentinel string for safe inclusion in a
 * list-style API response. The masked envelope replaces the encrypted
 * payload with a plain "***" so clients don't try to decrypt or re-send it.
 */
export function maskSecrets(type, data) {
  const def = getType(type);
  const out = { ...(data || {}) };
  if (def.freeform) {
    const secretMap = data?.__secret || {};
    for (const k of Object.keys(secretMap)) {
      if (out[k] !== undefined) out[k] = "***";
    }
    return out;
  }
  for (const f of def.fields) {
    if (!f.secret) continue;
    if (out[f.name] !== undefined && out[f.name] !== null && out[f.name] !== "") {
      out[f.name] = "***";
    }
  }
  return out;
}
