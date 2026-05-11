// Plugins API.
//
//   GET    /plugins                  list registered plugins (any auth'd user)
//   POST   /plugins/install          admin — install an HTTP-transport plugin from a manifest endpoint
//   POST   /plugins/:name/disable    admin — flip enabled=false
//   POST   /plugins/:name/enable     admin — flip enabled=true
//   DELETE /plugins/:name            admin — uninstall (only http/local sources; never core)
//   POST   /plugins/refresh          admin — reload the in-memory registry from DB
//
// `core` plugins (shipped in backend/src/plugins/builtin/) can be
// disabled but never deleted — the next worker boot upserts them back.

import { Router } from "express";
import { pool } from "../db/pool.js";
import { registry } from "../plugins/registry.js";
import { installFromEndpoint, installFromCatalog } from "../plugins/install.js";
import { loadCatalog } from "../plugins/catalog.js";
import { requireUser, requireRole } from "../middleware/auth.js";
import { ValidationError, NotFoundError, ForbiddenError } from "../utils/errors.js";
import { auditLog } from "../audit/log.js";

const router = Router();
router.use(requireUser);

// List — open to all signed-in users (the FlowDesigner palette needs
// it to render the node picker, viewers included).
router.get("/",
  requireRole("admin", "editor", "viewer"),
  async (_req, res, next) => {
    try {
      // Combine the in-memory snapshot with installation status
      // (enabled, source, health) from the DB so the admin Plugins
      // page can render rich rows without joining client-side.
      const inMem = new Map(registry.list().map(p => [p.name, p]));
      const { rows } = await pool.query(
        `SELECT name, version, transport_kind AS transport, endpoint,
                enabled, source, status, last_health_at, last_error,
                installed_at, updated_at
           FROM plugins
          ORDER BY name`,
      ).catch(() => ({ rows: [] }));
      const out = rows.map(r => ({
        ...inMem.get(r.name),
        ...r,
      }));
      // Plugins that exist in memory but not in DB (pre-migration
      // boot fallback) still surface so the editor still works.
      for (const [name, p] of inMem.entries()) {
        if (!out.some(o => o.name === name)) out.push(p);
      }
      res.json(out);
    } catch (e) { next(e); }
  },
);

// Admin-only management endpoints.
router.use(requireRole("admin"));

router.post("/install", async (req, res, next) => {
  try {
    const { endpoint, source = "local" } = req.body || {};
    if (typeof endpoint !== "string" || !/^https?:\/\//.test(endpoint)) {
      throw new ValidationError("endpoint must be an http(s):// URL");
    }
    const result = await installFromEndpoint({ endpoint, source });
    await registry.loadAll();
    await auditLog({
      req, action: "plugin.install",
      resource: { type: "plugin", name: result.name },
      metadata: { version: result.version, endpoint, source },
    });
    res.status(201).json(result);
  } catch (e) { next(e); }
});

// Catalog browse + install (Phase 3). The catalog is cached briefly
// in memory; `?refresh=1` bypasses the cache. Admin-only.
router.get("/catalog", async (req, res, next) => {
  try {
    const { data, fetchedAt, source } = await loadCatalog({
      refresh: req.query.refresh === "1" || req.query.refresh === "true",
    });
    // Compute installed-state per catalog row so the UI can show
    // a green checkmark vs an "Install" button without a second
    // round-trip. Look up by (name, version) when the schema
    // supports it; fall back to name-only otherwise.
    let installed = new Map();
    try {
      const r = await pool.query(
        `SELECT name, version, enabled FROM plugins`,
      );
      installed = new Map(r.rows.map(p => [`${p.name}@${p.version}`, p]));
    } catch (_) { /* pre-migration; that's fine */ }
    const annotated = (data.plugins || []).map(p => ({
      ...p,
      installed: installed.has(`${p.name}@${p.version}`),
    }));
    res.json({
      source, fetchedAt, name: data.name, version: data.version,
      plugins: annotated,
    });
  } catch (e) { next(e); }
});

router.post("/install-from-catalog", async (req, res, next) => {
  try {
    const { catalogEntryUrl, manifestUrl, manifestSha256, endpoint, source } = req.body || {};
    if (typeof manifestUrl !== "string" || !/^https?:\/\//.test(manifestUrl)) {
      throw new ValidationError("manifestUrl must be an http(s):// URL");
    }
    if (typeof endpoint !== "string" || !/^https?:\/\//.test(endpoint)) {
      throw new ValidationError("endpoint must be an http(s):// URL");
    }
    const result = await installFromCatalog({
      catalogEntryUrl, manifestUrl, manifestSha256, endpoint, source,
    });
    await registry.loadAll();
    await auditLog({
      req, action: "plugin.install",
      resource: { type: "plugin", name: result.name },
      metadata: {
        version: result.version, endpoint, source: result.source,
        manifestSha256: result.manifestSha256, manifestUrl,
      },
    });
    res.status(201).json(result);
  } catch (e) { next(e); }
});

router.post("/:name/disable", async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(
      `UPDATE plugins SET enabled = false, updated_at = NOW() WHERE name = $1`,
      [req.params.name],
    );
    if (rowCount === 0) throw new NotFoundError("plugin");
    await registry.loadAll();
    await auditLog({
      req, action: "plugin.disable",
      resource: { type: "plugin", name: req.params.name },
    });
    res.json({ name: req.params.name, enabled: false });
  } catch (e) { next(e); }
});

router.post("/:name/enable", async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(
      `UPDATE plugins SET enabled = true, updated_at = NOW() WHERE name = $1`,
      [req.params.name],
    );
    if (rowCount === 0) throw new NotFoundError("plugin");
    await registry.loadAll();
    await auditLog({
      req, action: "plugin.enable",
      resource: { type: "plugin", name: req.params.name },
    });
    res.json({ name: req.params.name, enabled: true });
  } catch (e) { next(e); }
});

// Uninstall — supports two shapes:
//   DELETE /plugins/:name              → removes ALL versions
//   DELETE /plugins/:name/:version     → removes just that version
//
// Core plugins are protected (next worker boot would re-upsert them
// anyway; surface a clearer error than silent recreation).
router.delete("/:name/:version", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT source FROM plugins WHERE name=$1 AND version=$2",
      [req.params.name, req.params.version],
    );
    if (rows.length === 0) throw new NotFoundError("plugin");
    if (rows[0].source === "core") {
      throw new ForbiddenError("cannot uninstall a core plugin; disable it instead");
    }
    await pool.query(
      "DELETE FROM plugins WHERE name=$1 AND version=$2",
      [req.params.name, req.params.version],
    );
    await registry.loadAll();
    await auditLog({
      req, action: "plugin.uninstall",
      resource: { type: "plugin", name: req.params.name },
      metadata: { version: req.params.version },
    });
    res.json({ name: req.params.name, version: req.params.version, uninstalled: true });
  } catch (e) { next(e); }
});

router.delete("/:name", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT version, source FROM plugins WHERE name=$1",
      [req.params.name],
    );
    if (rows.length === 0) throw new NotFoundError("plugin");
    if (rows.some(r => r.source === "core")) {
      throw new ForbiddenError("cannot uninstall a core plugin; disable it instead");
    }
    await pool.query("DELETE FROM plugins WHERE name = $1", [req.params.name]);
    await registry.loadAll();
    await auditLog({
      req, action: "plugin.uninstall",
      resource: { type: "plugin", name: req.params.name },
      metadata: { versions: rows.map(r => r.version) },
    });
    res.json({ name: req.params.name, uninstalled: true, versions: rows.map(r => r.version) });
  } catch (e) { next(e); }
});

// Promote a specific (name, version) to the default. The partial
// unique index guarantees at most one default per name, so we flip
// the others off in the same transaction.
router.post("/:name/:version/set-default", async (req, res, next) => {
  try {
    await pool.query("BEGIN");
    try {
      const { rowCount } = await pool.query(
        "UPDATE plugins SET is_default=false WHERE name=$1 AND is_default=true",
        [req.params.name],
      );
      const { rowCount: promoted } = await pool.query(
        "UPDATE plugins SET is_default=true, updated_at=NOW() WHERE name=$1 AND version=$2",
        [req.params.name, req.params.version],
      );
      if (promoted === 0) {
        await pool.query("ROLLBACK");
        throw new NotFoundError("plugin");
      }
      await pool.query("COMMIT");
    } catch (e) {
      await pool.query("ROLLBACK").catch(() => {});
      throw e;
    }
    await registry.loadAll();
    await auditLog({
      req, action: "plugin.set-default",
      resource: { type: "plugin", name: req.params.name },
      metadata: { version: req.params.version },
    });
    res.json({ name: req.params.name, version: req.params.version, isDefault: true });
  } catch (e) { next(e); }
});

router.post("/refresh", async (req, res, next) => {
  try {
    await registry.loadAll();
    res.json({ ok: true, count: registry.list().length });
  } catch (e) { next(e); }
});

export default router;
