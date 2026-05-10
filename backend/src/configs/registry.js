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

import { encryptValue, decryptValue, isEncrypted } from "./crypto.js";

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
 * Encrypt all secret fields in a normalised data object. Returns a new
 * object — original is left untouched. Already-encrypted values are kept
 * as-is so update calls that don't re-supply the secret don't re-encrypt
 * an already-stored ciphertext.
 */
export function encryptSecrets(type, data) {
  const def = getType(type);
  const out = { ...data };
  if (def.freeform) {
    // Generic configs encode "this row is a secret" by carrying a sibling
    // marker map at __secret: { keyName: true }. The UI manages this map
    // when the user toggles each row.
    const secretMap = data?.__secret || {};
    for (const k of Object.keys(secretMap)) {
      if (out[k] === undefined || isEncrypted(out[k])) continue;
      out[k] = encryptValue(out[k]);
    }
    return out;
  }
  for (const f of def.fields) {
    if (!f.secret) continue;
    const cur = out[f.name];
    if (cur === undefined || cur === null || cur === "") continue;
    if (isEncrypted(cur)) continue;
    out[f.name] = encryptValue(cur);
  }
  return out;
}

/**
 * Decrypt all secret fields in a stored data object. Returns a new object
 * with plaintext values — used by the engine + trigger manager when wiring
 * configs into ctx.config and into trigger drivers.
 */
export function decryptSecrets(type, data) {
  const out = { ...(data || {}) };
  for (const k of Object.keys(out)) {
    if (isEncrypted(out[k])) out[k] = decryptValue(out[k]);
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
