// Plugin healthcheck loop.
//
// Probes /readyz on every http-transport plugin every
// PLUGIN_HEALTHCHECK_INTERVAL_MS (default 60s). Updates each row's
// status + last_health_at + last_error. The Plugins admin page reads
// these columns to render its status badge.
//
// In-process plugins are always 'healthy' by definition (they're the
// same Node process as the worker that's polling them); we skip
// them.
//
// Failure semantics:
//   • 2xx response                → status='healthy', last_error=null
//   • non-2xx / unreachable / TO  → status='degraded' (first failure),
//                                   → status='down'   (third consecutive failure)
//
// Stops on SIGTERM via the worker's existing shutdown sequence.

import { pool } from "../db/pool.js";
import { log } from "../utils/logger.js";

const INTERVAL_MS = parseInt(process.env.PLUGIN_HEALTHCHECK_INTERVAL_MS || "60000", 10);
const TIMEOUT_MS  = parseInt(process.env.PLUGIN_HEALTHCHECK_TIMEOUT_MS  || "3000",  10);
// After N consecutive failures we mark the plugin 'down' rather
// than 'degraded'. 'down' is a stronger signal in the UI and in
// alerts.
const DOWN_THRESHOLD = parseInt(process.env.PLUGIN_HEALTHCHECK_DOWN_AFTER || "3", 10);

let _timer = null;
const _failureStreaks = new Map();   // `${name}@${version}` → count

export function startHealthcheck() {
  if (_timer) return;
  if (!Number.isFinite(INTERVAL_MS) || INTERVAL_MS < 5_000) {
    log.info("plugin healthcheck disabled (interval < 5s)");
    return;
  }
  // Run once on boot so the admin UI shows fresh status without
  // waiting for the first interval to elapse.
  runOnce().catch((e) => log.warn("plugin healthcheck initial pass failed", { error: e.message }));
  _timer = setInterval(() => {
    runOnce().catch((e) => log.warn("plugin healthcheck pass failed", { error: e.message }));
  }, INTERVAL_MS);
  if (typeof _timer.unref === "function") _timer.unref();
  log.info("plugin healthcheck started", { intervalMs: INTERVAL_MS });
}

export function stopHealthcheck() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

async function runOnce() {
  // Pull only the columns we need; tolerate the multi-version
  // schema (Phase 3) and the single-version one (Phase 1).
  let rows;
  try {
    const r = await pool.query(
      `SELECT name, version, endpoint
         FROM plugins
        WHERE transport_kind = 'http' AND enabled = true`,
    );
    rows = r.rows;
  } catch (e) {
    if (e.code === "42P01") return;        // pre-migration; nothing to do
    throw e;
  }
  if (rows.length === 0) return;
  await Promise.all(rows.map(probe));
}

async function probe(row) {
  const key = `${row.name}@${row.version}`;
  const url = `${row.endpoint.replace(/\/$/, "")}/readyz`;
  const ac  = new AbortController();
  const t   = setTimeout(() => ac.abort(), TIMEOUT_MS);
  if (typeof t.unref === "function") t.unref();

  let ok = false, error = null;
  try {
    const r = await fetch(url, { signal: ac.signal });
    ok = r.ok;
    if (!ok) error = `HTTP ${r.status}`;
  } catch (e) {
    error = e.name === "AbortError" ? `timed out after ${TIMEOUT_MS}ms` : (e.message || String(e));
  } finally {
    clearTimeout(t);
  }

  const streak = ok ? 0 : (_failureStreaks.get(key) || 0) + 1;
  _failureStreaks.set(key, streak);
  const status = ok ? "healthy" : (streak >= DOWN_THRESHOLD ? "down" : "degraded");

  try {
    await pool.query(
      `UPDATE plugins
          SET status = $3,
              last_health_at = NOW(),
              last_error     = $4
        WHERE name = $1 AND version = $2`,
      [row.name, row.version, status, error],
    );
  } catch (e) {
    // Schema may be Phase-1 (no last_error column). Soft-fail.
    if (e.code !== "42703") log.warn("plugin healthcheck status update failed", { key, error: e.message });
  }
}
