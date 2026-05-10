// Shared helpers for the SQL action plugins.
//
// Lives outside src/plugins/builtin/ so the plugin auto-loader doesn't try to
// register it as an action. All five sql.* plugins import from here.
//
// Connection sourcing:
//   - The plugins now resolve a stored `database` configuration by name
//     (managed from the Home page → Configurations table) and assemble a
//     postgres:// connection string from its host/port/database/user/pass.
//   - The pool cache below keys on the assembled connection string, so
//     repeat calls against the same config reuse the same pool.

import pg from "pg";
import { config } from "../../config.js";
import { log } from "../../utils/logger.js";

/**
 * Resolve a stored database config from `ctx.config[<name>]` and return a
 * postgres:// connection string. Throws a friendly error if the config
 * isn't there or is missing a host / database name.
 */
export function resolveConfigConnString(ctx, name) {
  if (!name || typeof name !== "string") {
    throw new Error("sql: `config` is required (name of a stored database configuration)");
  }
  const cfg = ctx?.config?.[name];
  if (!cfg || typeof cfg !== "object") {
    throw new Error(
      `sql: config "${name}" not found. Create a configuration of type ` +
      `database on the Home page → Configurations.`,
    );
  }
  return buildConnectionString(cfg);
}

/**
 * Build a postgres:// connection string from a `database` config blob.
 * The DB engine is currently fixed to Postgres on the runtime side
 * (sql/util uses pg.Pool); other engines validate fine in the registry
 * but won't actually connect.
 */
export function buildConnectionString(cfg) {
  if (!cfg.host)     throw new Error("sql: database config has no `host` set");
  if (!cfg.database) throw new Error("sql: database config has no `database` set");
  const user = encodeURIComponent(cfg.username || "");
  const pass = encodeURIComponent(cfg.password || "");
  const auth = user ? (pass ? `${user}:${pass}@` : `${user}@`) : "";
  const port = cfg.port ? `:${cfg.port}` : "";
  const db   = encodeURIComponent(cfg.database);
  const ssl  = cfg.ssl ? "?sslmode=require" : "";
  // Engine prefix is informational only — pg ignores it as long as the
  // shape is `postgres://` or `postgresql://`.
  return `postgres://${auth}${cfg.host}${port}/${db}${ssl}`;
}

// One pool per distinct connection string — opens lazily, reused across calls.
const pools = new Map();

export function getPool(connectionString) {
  const cs = connectionString || config.databaseUrl;
  let pool = pools.get(cs);
  if (!pool) {
    pool = new pg.Pool({ connectionString: cs, max: 5 });
    pool.on("error", (e) => log.warn("sql pool error", { error: e.message }));
    pools.set(cs, pool);
  }
  return pool;
}

// Identifier (table / column / schema-qualified) — quoted as "name" with strict
// validation to keep it nowhere near user-controlled SQL.
const IDENT_PART = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function quoteIdent(name) {
  if (typeof name !== "string" || !name.length) {
    throw new Error(`Invalid identifier: ${JSON.stringify(name)}`);
  }
  const parts = name.split(".");
  for (const p of parts) {
    if (!IDENT_PART.test(p)) {
      throw new Error(`Invalid identifier: ${JSON.stringify(name)}`);
    }
  }
  return parts.map(p => `"${p}"`).join(".");
}

// `orderBy` is necessarily raw-ish, so we validate the shape: comma-separated
// list of column names (optionally schema-qualified), each followed by an
// optional ASC | DESC | NULLS FIRST | NULLS LAST. Everything else is rejected.
const ORDERBY_OK = /^[A-Za-z_][\w.]*(\s+(ASC|DESC))?(\s+NULLS\s+(FIRST|LAST))?(\s*,\s*[A-Za-z_][\w.]*(\s+(ASC|DESC))?(\s+NULLS\s+(FIRST|LAST))?)*$/i;
export function safeOrderBy(s) {
  if (s == null || s === "") return "";
  if (typeof s !== "string" || !ORDERBY_OK.test(s.trim())) {
    throw new Error(`Invalid orderBy: ${s}`);
  }
  return s.trim();
}

/**
 * Build a parameterized WHERE clause from a key-value object.
 *   { id: 1, status: "x" } → " WHERE \"id\" = $1 AND \"status\" = $2"
 *   { col: null }          → " WHERE \"col\" IS NULL"  (no param consumed)
 *   { col: ["a", "b"] }    → " WHERE \"col\" = ANY($1)"
 */
export function buildWhere(where, startIdx = 1) {
  if (!where || typeof where !== "object" || Array.isArray(where)) {
    return { sql: "", params: [] };
  }
  const keys = Object.keys(where);
  if (keys.length === 0) return { sql: "", params: [] };
  const params = [];
  let idx = startIdx;
  const parts = keys.map((k) => {
    const v = where[k];
    if (v === null) return `${quoteIdent(k)} IS NULL`;
    if (Array.isArray(v)) {
      params.push(v);
      return `${quoteIdent(k)} = ANY($${idx++})`;
    }
    params.push(v);
    return `${quoteIdent(k)} = $${idx++}`;
  });
  return { sql: ` WHERE ${parts.join(" AND ")}`, params };
}

/** Run a parameterized query and return { rows, rowCount }. */
export async function runQuery(connectionString, sql, params = []) {
  const pool = getPool(connectionString);
  const { rows, rowCount } = await pool.query(sql, params);
  return { rows, rowCount: rowCount ?? 0 };
}

/**
 * Coerce the `params` input into the array shape pg expects. The property
 * panel renders `params` as a single-line text input so the user can type a
 * `${var}` reference; the engine usually resolves that to an array, but a
 * literal JSON string can sneak through (e.g. when params is left as a
 * paste-in `[1, "x"]`). Either form is accepted; everything else throws.
 */
/**
 * Build the standard SQL plugin input schema. All five sql.* plugins share
 * the same three-input shape; only the description differs. Keeping the
 * factory here means any future tweak (placeholder text, validation rules)
 * lands in one place.
 */
export function sqlInputSchema({ sqlPlaceholder, sqlDescription }) {
  return {
    type: "object",
    required: ["config", "sql"],
    properties: {
      config: {
        type: "string",
        title: "Database config",
        minLength: 1,
        description:
          "Name of a stored database configuration. Manage from the Home " +
          "page → Configurations.",
      },
      sql: {
        type: "string",
        title: "SQL",
        format: "textarea",
        minLength: 1,
        placeholder: sqlPlaceholder,
        description: sqlDescription,
      },
      // Typeless on purpose so the property panel renders a plain text
      // input — the user types a ${var} reference resolving to an array.
      params: {
        title: "Params",
        placeholder: "${params}",
        description:
          "Reference to an array of bound values for $1, $2, … Build the " +
          "array upstream with a transform node. Leave blank when the SQL " +
          "has no placeholders.",
      },
    },
  };
}

/** Standard output shape for every sql.* plugin. */
export const sqlOutputSchema = {
  type: "object",
  required: ["rows", "rowCount"],
  properties: {
    rows:     { type: "array" },
    rowCount: { type: "integer" },
  },
};

export function normalizeParams(raw) {
  if (raw == null || raw === "") return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed;
      } catch { /* fall through */ }
    }
    throw new Error(
      "sql: `params` must resolve to an array. Pass `${var}` referencing an " +
      "array built upstream (e.g. by a transform node) or leave it blank.",
    );
  }
  throw new Error(`sql: \`params\` must be an array, got ${typeof raw}`);
}
