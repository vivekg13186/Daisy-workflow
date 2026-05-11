// Marketplace catalog — fetches + caches the plugin index Daisy
// admins browse from the Plugins page.
//
// Source order:
//   1. process.env.PLUGIN_CATALOG_URL  — remote HTTPS catalog
//   2. deploy/plugin-catalog.example.json (or PLUGIN_CATALOG_FILE)
//      — local-disk fallback. Useful for air-gapped deployments
//      and CI / tests.
//
// Cached in memory for CATALOG_TTL_MS (default 5 min). `?refresh=1`
// on the endpoint bypasses the cache.
//
// Catalog schema (single JSON object):
//
//   {
//     "name":    "Daisy-DAG Official",
//     "version": "1",
//     "plugins": [
//       {
//         "name":           "reddit.search",       // matches plugin manifest.name
//         "version":        "0.1.0",                // matches plugin manifest.version
//         "summary":        "Search Reddit posts.",
//         "category":       "social",
//         "tags":           ["reddit", "search"],
//         "homepage":       "https://github.com/.../reddit-plugin",
//         "manifestUrl":    "https://.../manifest.json",
//         "manifestSha256": "<hex>",                // verified at install time
//         "containerImage": "ghcr.io/.../reddit:0.1.0",
//         "containerPort":  8080
//       }
//     ]
//   }

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../utils/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_TTL_MS = 5 * 60_000;

let _cache = null;        // { data, fetchedAt, source }
let _cachedAt = 0;

/**
 * Return the marketplace catalog. Cached for CATALOG_TTL_MS; pass
 * `{ refresh: true }` to force re-fetch.
 *
 * Throws on unreachable / malformed catalog so the admin UI can
 * surface a clear error instead of silently rendering an empty list.
 */
export async function loadCatalog({ refresh = false } = {}) {
  if (!refresh && _cache && Date.now() - _cachedAt < CATALOG_TTL_MS) {
    return _cache;
  }

  const url      = process.env.PLUGIN_CATALOG_URL || null;
  const filePath = process.env.PLUGIN_CATALOG_FILE
                || path.resolve(__dirname, "../../../deploy/plugin-catalog.example.json");

  let raw;
  let source;
  if (url) {
    const r = await fetchWithTimeout(url, 5000);
    raw = await r.text();
    source = url;
  } else {
    try {
      raw = fs.readFileSync(filePath, "utf8");
      source = filePath;
    } catch (e) {
      log.warn("plugin catalog unavailable", { error: e.message });
      throw new Error(
        "Plugin catalog not configured. Set PLUGIN_CATALOG_URL to a remote catalog or place a JSON file at deploy/plugin-catalog.example.json.",
      );
    }
  }

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { throw new Error(`catalog ${source} is not JSON: ${e.message}`); }

  validate(parsed, source);

  const out = { data: parsed, fetchedAt: Date.now(), source };
  _cache    = out;
  _cachedAt = out.fetchedAt;
  log.info("plugin catalog loaded", {
    source, count: parsed.plugins?.length || 0,
  });
  return out;
}

function validate(c, source) {
  if (!c || typeof c !== "object") throw new Error(`${source}: catalog is not an object`);
  if (!Array.isArray(c.plugins))   throw new Error(`${source}: catalog.plugins must be an array`);
  for (const p of c.plugins) {
    if (typeof p.name        !== "string") throw new Error(`${source}: plugin.name missing`);
    if (typeof p.version     !== "string") throw new Error(`${source}: ${p.name} missing version`);
    if (typeof p.manifestUrl !== "string") throw new Error(`${source}: ${p.name}@${p.version} missing manifestUrl`);
  }
}

async function fetchWithTimeout(url, timeoutMs) {
  const ac = new AbortController();
  const t  = setTimeout(() => ac.abort(), timeoutMs);
  if (typeof t.unref === "function") t.unref();
  try {
    const r = await fetch(url, { signal: ac.signal });
    if (!r.ok) throw new Error(`${url} returned HTTP ${r.status}`);
    return r;
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`${url} timed out after ${timeoutMs}ms`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}
