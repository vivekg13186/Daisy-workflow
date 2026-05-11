// Plugin installer — fetch a plugin's /manifest, validate it, and
// persist the row to the plugins table.
//
// Used by:
//   • POST /plugins/install         (admin API)
//   • npm run install-plugin        (CLI)
//
// Validation:
//   • Manifest must declare name + version + (input|output)Schema.
//   • If transport is declared 'http', endpoint must be reachable.
//   • Schemas, if present, must be parseable JSON Schema.
//
// What's NOT done here (Phase 2):
//   • Checksum / signature verification.
//   • Auto-pulling the container image.
//   • Side-by-side versioning.

import crypto from "node:crypto";
import { pool } from "../db/pool.js";
import { log } from "../utils/logger.js";

const FETCH_TIMEOUT_MS = 10_000;

/**
 * Probe an endpoint for its manifest + readiness, then UPSERT the
 * plugins row.
 *
 *   installFromEndpoint({ endpoint, source = "local" })
 *
 * Returns { name, version, transport, endpoint, source, status }.
 */
export async function installFromEndpoint({ endpoint, source = "local" }) {
  if (!endpoint) throw new Error("endpoint required");
  const base = endpoint.replace(/\/$/, "");

  // 1. Fetch the manifest with a tight timeout. A misconfigured URL
  //    shouldn't hang the install request for 30s.
  const manifest = await fetchJson(`${base}/manifest`, FETCH_TIMEOUT_MS);
  validateManifest(manifest);

  // 2. Probe /readyz so we can record initial status. Not fatal if
  //    the plugin is starting up — we just record `unknown`.
  let status = "unknown";
  let lastError = null;
  try {
    await fetchJson(`${base}/readyz`, 3000);
    status = "healthy";
  } catch (e) {
    status = "degraded";
    lastError = e.message;
  }

  // 3. Stamp the transport block in the manifest so future loads
  //    don't need to assume.
  const final = {
    ...manifest,
    transport: {
      kind:      "http",
      streaming: manifest.transport?.streaming === true,
    },
  };

  await persistPluginRow({
    manifest: final,
    transport: "http",
    endpoint: base,
    source,
    status,
    lastError,
    catalogEntryUrl: null,
    manifestSha256: null,
  });

  log.info("plugin installed", {
    name: manifest.name, version: manifest.version,
    endpoint: base, source, status,
  });

  return {
    name:      manifest.name,
    version:   manifest.version,
    transport: "http",
    endpoint:  base,
    source,
    status,
  };
}

/**
 * Catalog-driven install. Differs from installFromEndpoint:
 *   • Manifest comes from a (potentially static) URL, not a live
 *     plugin endpoint. The plugin container may not be running yet
 *     — operator runs it themselves after the install completes.
 *   • SHA-256 of the manifest body is verified against the catalog's
 *     declared checksum; mismatch refuses the install.
 *   • Source defaults to "marketplace:<catalogEntryUrl>" so upgrade
 *     flows can target it later.
 *
 *   installFromCatalog({
 *     catalogEntryUrl,      // the catalog row's identifier
 *     manifestUrl,          // where the manifest lives
 *     manifestSha256,       // expected checksum (optional but recommended)
 *     endpoint,             // where the operator will run the container
 *     source?,              // override; default "marketplace:<catalogEntryUrl>"
 *   })
 */
export async function installFromCatalog({
  catalogEntryUrl,
  manifestUrl,
  manifestSha256 = null,
  endpoint,
  source,
}) {
  if (!manifestUrl) throw new Error("manifestUrl required");
  if (!endpoint)    throw new Error("endpoint required (where the plugin container is reachable)");
  const base = endpoint.replace(/\/$/, "");

  // 1. Fetch the manifest body verbatim so we can checksum it
  //    before parsing. (Parsing first + then stringifying again
  //    would silently re-format whitespace and change the hash.)
  const ac = new AbortController();
  const t  = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  if (typeof t.unref === "function") t.unref();
  let bodyText;
  try {
    const r = await fetch(manifestUrl, { signal: ac.signal });
    if (!r.ok) throw new Error(`${manifestUrl} returned HTTP ${r.status}`);
    bodyText = await r.text();
  } finally { clearTimeout(t); }

  // 2. Verify the SHA-256 if the catalog declared one.
  const actualSha = sha256Hex(bodyText);
  if (manifestSha256 && manifestSha256.toLowerCase() !== actualSha) {
    throw new Error(
      `manifest checksum mismatch: catalog declared ${manifestSha256}, got ${actualSha}. ` +
      `Refusing to install — the manifest may have been tampered with.`,
    );
  }

  let manifest;
  try { manifest = JSON.parse(bodyText); }
  catch (e) { throw new Error(`manifest is not JSON: ${e.message}`); }
  validateManifest(manifest);

  // 3. Probe /readyz at the operator-supplied endpoint. Not fatal
  //    if the container isn't running yet — record "unknown" + a
  //    note in last_error so the admin Plugins page tells them to
  //    bring the container up.
  let status = "unknown";
  let lastError = null;
  try {
    await fetchJson(`${base}/readyz`, 3000);
    status = "healthy";
  } catch (e) {
    status = "degraded";
    lastError = `plugin endpoint not reachable yet: ${e.message}`;
  }

  const final = {
    ...manifest,
    transport: { kind: "http", streaming: manifest.transport?.streaming === true },
  };

  const provenance = source || (catalogEntryUrl ? `marketplace:${catalogEntryUrl}` : "marketplace");

  await persistPluginRow({
    manifest: final,
    transport: "http",
    endpoint: base,
    source: provenance,
    status,
    lastError,
    catalogEntryUrl: catalogEntryUrl || manifestUrl,
    manifestSha256: actualSha,
  });

  log.info("plugin installed from catalog", {
    name: manifest.name, version: manifest.version,
    endpoint: base, source: provenance, status,
  });

  return {
    name:           manifest.name,
    version:        manifest.version,
    transport:      "http",
    endpoint:       base,
    source:         provenance,
    status,
    manifestSha256: actualSha,
  };
}

function sha256Hex(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

// ────────────────────────────────────────────────────────────────────
// Common INSERT — handles both Phase 1 (PK=name) and Phase 3
// (PK=name,version) schemas so the install paths work cleanly across
// the migration window.
// ────────────────────────────────────────────────────────────────────

async function persistPluginRow({
  manifest, transport, endpoint, source, status, lastError,
  catalogEntryUrl, manifestSha256,
}) {
  // Phase 3: PK is (name, version). is_default + checksum + catalog
  // metadata columns exist.
  const sqlV3 = `
    INSERT INTO plugins (
      name, version, manifest, transport_kind, endpoint, source,
      status, last_health_at, last_error,
      manifest_sha256, catalog_entry_url, is_default,
      homepage, category, tags,
      enabled, updated_at
    ) VALUES (
      $1, $2, $3::jsonb, $4, $5, $6,
      $7, NOW(), $8,
      $9, $10, true,
      $11, $12, $13::jsonb,
      true, NOW()
    )
    ON CONFLICT (name, version) DO UPDATE
       SET manifest          = EXCLUDED.manifest,
           transport_kind    = EXCLUDED.transport_kind,
           endpoint          = EXCLUDED.endpoint,
           source            = EXCLUDED.source,
           status            = EXCLUDED.status,
           last_health_at    = EXCLUDED.last_health_at,
           last_error        = EXCLUDED.last_error,
           manifest_sha256   = EXCLUDED.manifest_sha256,
           catalog_entry_url = EXCLUDED.catalog_entry_url,
           homepage          = EXCLUDED.homepage,
           category          = EXCLUDED.category,
           tags              = EXCLUDED.tags,
           enabled           = true,
           updated_at        = NOW()`;
  try {
    await pool.query(sqlV3, [
      manifest.name, manifest.version, JSON.stringify(manifest),
      transport, endpoint, source,
      status, lastError,
      manifestSha256, catalogEntryUrl,
      manifest.homepage || null, manifest.category || manifest.ui?.category || null,
      JSON.stringify(Array.isArray(manifest.tags) ? manifest.tags : []),
    ]);
    return;
  } catch (e) {
    if (e.code !== "42703") throw e;     // not "column missing" — re-raise
  }
  // Fallback: Phase 1 schema (PK=name only, no checksum / catalog cols).
  await pool.query(
    `INSERT INTO plugins (name, version, manifest, transport_kind, endpoint,
                          source, status, last_health_at, last_error, enabled, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, NOW(), $8, true, NOW())
       ON CONFLICT (name) DO UPDATE
          SET version        = EXCLUDED.version,
              manifest       = EXCLUDED.manifest,
              transport_kind = EXCLUDED.transport_kind,
              endpoint       = EXCLUDED.endpoint,
              source         = EXCLUDED.source,
              status         = EXCLUDED.status,
              last_health_at = EXCLUDED.last_health_at,
              last_error     = EXCLUDED.last_error,
              enabled        = true,
              updated_at     = NOW()`,
    [
      manifest.name, manifest.version, JSON.stringify(manifest),
      transport, endpoint, source, status, lastError,
    ],
  );
}

function validateManifest(m) {
  if (!m || typeof m !== "object") {
    throw new Error("manifest is not an object");
  }
  if (typeof m.name !== "string" || !/^[a-z][a-z0-9_.-]*$/.test(m.name)) {
    throw new Error(`manifest.name must be a dotted-string identifier; got "${m.name}"`);
  }
  if (typeof m.version !== "string" || !/^\d+\.\d+\.\d+/.test(m.version)) {
    throw new Error(`manifest.version must be semver; got "${m.version}"`);
  }
  if (m.inputSchema  && typeof m.inputSchema  !== "object") throw new Error("manifest.inputSchema must be an object");
  if (m.outputSchema && typeof m.outputSchema !== "object") throw new Error("manifest.outputSchema must be an object");
}

async function fetchJson(url, timeoutMs) {
  const ac = new AbortController();
  const t  = setTimeout(() => ac.abort(), timeoutMs);
  if (typeof t.unref === "function") t.unref();
  try {
    const r = await fetch(url, { signal: ac.signal });
    if (!r.ok) throw new Error(`${url} returned HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`${url} timed out after ${timeoutMs}ms`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}
