// Agents API — CRUD for named LLM personas.
//
// An agent row pairs a system prompt with a stored ai.provider config.
// The `agent` plugin runs an agent by title, sending the workflow's input
// text alongside the prompt to the configured provider.
//
// Auth model:
//   • Reads (list/get)              — admin, editor, viewer.
//                                     Editors see them in node pickers;
//                                     viewers see them while reading
//                                     execution histories.
//   • Writes (create/update/delete) — admin, editor (workflow authoring).
//
//   GET    /agents               list
//   GET    /agents/:id           single
//   POST   /agents               create
//   PUT    /agents/:id           update
//   DELETE /agents/:id           remove

import { Router } from "express";
import { v4 as uuid } from "uuid";
import { pool } from "../db/pool.js";
import { ValidationError, NotFoundError } from "../utils/errors.js";
import { requireUser, requireRole } from "../middleware/auth.js";

const router = Router();
router.use(requireUser);

// Titles double as the lookup key for the agent plugin (`agent: "<title>"`),
// so they need to be friendly but predictable.
const TITLE_RE = /^[A-Za-z0-9 _.\-]+$/;

router.get("/", requireRole("admin", "editor", "viewer"), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT a.id, a.title, a.prompt, a.config_name, a.description,
              a.created_at, a.updated_at,
              c.type AS config_type
         FROM agents a
         LEFT JOIN configs c
                ON c.name = a.config_name
               AND c.workspace_id = a.workspace_id
        WHERE a.workspace_id = $1
        ORDER BY a.title`,
      [req.user.workspaceId],
    );
    res.json(rows);
  } catch (e) { next(e); }
});

router.get("/:id", requireRole("admin", "editor", "viewer"), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM agents WHERE id=$1 AND workspace_id=$2",
      [req.params.id, req.user.workspaceId],
    );
    if (rows.length === 0) throw new NotFoundError("agent");
    res.json(rows[0]);
  } catch (e) { next(e); }
});

router.post("/", requireRole("admin", "editor"), async (req, res, next) => {
  try {
    const { title, prompt, config_name, description } = req.body || {};
    validatePayload({ title, prompt, config_name }, /* requireAll */ true);
    await ensureConfigExists(config_name, req.user.workspaceId);

    const id = uuid();
    try {
      await pool.query(
        `INSERT INTO agents (id, title, prompt, config_name, description, workspace_id)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, title.trim(), prompt, config_name, description || null, req.user.workspaceId],
      );
    } catch (e) {
      if (e.code === "23505") {
        throw new ValidationError(`an agent titled "${title}" already exists`);
      }
      throw e;
    }
    res.status(201).json({ id, title });
  } catch (e) { next(e); }
});

router.put("/:id", requireRole("admin", "editor"), async (req, res, next) => {
  try {
    const { title, prompt, config_name, description } = req.body || {};
    if (config_name !== undefined) await ensureConfigExists(config_name, req.user.workspaceId);
    validatePayload({ title, prompt, config_name }, /* requireAll */ false);

    const sets = [], params = [];
    if (title       !== undefined) { params.push(title.trim()); sets.push(`title = $${params.length}`); }
    if (prompt      !== undefined) { params.push(prompt);       sets.push(`prompt = $${params.length}`); }
    if (config_name !== undefined) { params.push(config_name);  sets.push(`config_name = $${params.length}`); }
    if (description !== undefined) { params.push(description || null); sets.push(`description = $${params.length}`); }
    if (sets.length === 0) return res.json({ id: req.params.id, updated: false });
    params.push(req.params.id);
    const idIdx = params.length;
    params.push(req.user.workspaceId);
    const wsIdx = params.length;
    sets.push("updated_at = NOW()");
    try {
      const { rowCount } = await pool.query(
        `UPDATE agents SET ${sets.join(", ")}
          WHERE id = $${idIdx} AND workspace_id = $${wsIdx}`,
        params,
      );
      if (rowCount === 0) throw new NotFoundError("agent");
    } catch (e) {
      if (e.code === "23505") {
        throw new ValidationError(`an agent titled "${title}" already exists`);
      }
      throw e;
    }
    res.json({ id: req.params.id, updated: true });
  } catch (e) { next(e); }
});

router.delete("/:id", requireRole("admin", "editor"), async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(
      "DELETE FROM agents WHERE id=$1 AND workspace_id=$2",
      [req.params.id, req.user.workspaceId],
    );
    if (rowCount === 0) throw new NotFoundError("agent");
    res.status(200).json({ ok: true, id: req.params.id, deleted: "agent" });
  } catch (e) { next(e); }
});

// ── helpers ───────────────────────────────────────────────────────────

function validatePayload({ title, prompt, config_name }, requireAll) {
  if (requireAll) {
    if (!title || !prompt || !config_name) {
      throw new ValidationError("title, prompt, and config_name are required");
    }
  }
  if (title !== undefined) {
    if (typeof title !== "string" || !title.trim()) throw new ValidationError("title must be a non-empty string");
    if (!TITLE_RE.test(title.trim())) {
      throw new ValidationError("title may contain letters, digits, spaces, underscores, dots, and dashes only");
    }
  }
  if (prompt !== undefined) {
    if (typeof prompt !== "string" || !prompt.trim()) throw new ValidationError("prompt must be a non-empty string");
  }
  if (config_name !== undefined) {
    if (typeof config_name !== "string" || !config_name.trim()) throw new ValidationError("config_name must be a non-empty string");
  }
}

async function ensureConfigExists(name, workspaceId) {
  const { rows } = await pool.query(
    "SELECT type FROM configs WHERE name=$1 AND workspace_id=$2",
    [name, workspaceId],
  );
  if (rows.length === 0) {
    throw new ValidationError(`config "${name}" not found in this workspace. Create one of type ai.provider on the Configurations page.`);
  }
  if (rows[0].type !== "ai.provider") {
    throw new ValidationError(`config "${name}" is type "${rows[0].type}", but agents require type ai.provider.`);
  }
}

export default router;
