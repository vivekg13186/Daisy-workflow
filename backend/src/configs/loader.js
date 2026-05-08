// Loads typed configs from Postgres, decrypts their secrets, and shapes
// them for the engine + the trigger manager.
//
// Two outputs are exposed:
//
//   • loadConfigsMap()  → { <name>: { <key>: <plainValue> } }
//
//     This goes into ctx.config so DSL expressions like
//     `${config.prodDb.host}` resolve via the existing path walker.
//
//   • buildConfigEnv(map) → { CONFIG_<NAME>_<KEY>: <stringValue> }
//
//     Flat env-var-style projection that goes into ctx.env so script-style
//     plugins can read configs the way they'd read process.env.
//     Object-typed values are JSON-stringified; everything else is coerced
//     via String(). Names containing characters that are illegal in env
//     identifiers are upper-snake-cased on the way through.

import { pool } from "../db/pool.js";
import { decryptSecrets } from "./registry.js";
import { log } from "../utils/logger.js";

/**
 * Load every config row, decrypt secret fields, and return as a map keyed
 * by config `name`. Errors on individual rows are logged and that row is
 * skipped — one broken config shouldn't stop the run.
 */
export async function loadConfigsMap() {
  const out = {};
  try {
    const { rows } = await pool.query("SELECT name, type, data FROM configs");
    for (const row of rows) {
      try {
        out[row.name] = decryptSecrets(row.type, row.data || {});
        // Drop the editor-only marker — engine consumers shouldn't see it.
        if (out[row.name].__secret) delete out[row.name].__secret;
      } catch (e) {
        log.warn("config decrypt failed", { name: row.name, error: e.message });
      }
    }
  } catch (e) {
    // Configs table missing (fresh DB before migrations) → return empty.
    if (e.code === "42P01") return out;
    throw e;
  }
  return out;
}

/** Convert a configs map into env-var-style flat keys. */
export function buildConfigEnv(map) {
  const env = {};
  for (const [name, fields] of Object.entries(map || {})) {
    const NAME = toEnvSegment(name);
    for (const [k, v] of Object.entries(fields || {})) {
      const KEY = toEnvSegment(k);
      env[`CONFIG_${NAME}_${KEY}`] = stringify(v);
    }
  }
  return env;
}

function toEnvSegment(s) {
  return String(s)
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function stringify(v) {
  if (v == null) return "";
  if (typeof v === "string")  return v;
  if (typeof v === "number")  return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  try { return JSON.stringify(v); } catch { return String(v); }
}
