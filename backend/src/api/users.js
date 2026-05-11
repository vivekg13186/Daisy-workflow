// User management — admin only.
//
// Scope:
//   • A workspace's admins can manage every user whose primary
//     workspace_id == the caller's. Multi-workspace memberships
//     (workspace_members) are listed but not edited here — that
//     happens through /api/workspaces.
//
//   • A non-admin who somehow hits these routes gets 403 (the
//     requireRole gate) — never just an empty list.
//
// Endpoints:
//   GET    /users                 list users in caller's workspace
//   POST   /users                 create a user with a chosen password
//                                 body: { email, password, role, displayName? }
//   PUT    /users/:id             body: { role?, status?, displayName? }
//   POST   /users/:id/password    body: { password }
//   DELETE /users/:id             soft-disable (sets status='disabled')
//
// Safety rails:
//   • Cannot demote / disable / delete yourself (avoids "I just locked
//     myself out" support tickets).
//   • Cannot demote / disable the last active admin in a workspace
//     (same idea, harder to recover from).
//   • Cannot create a user in another workspace (workspace_id is set
//     from req.user, never the body).
//   • Email is normalised to lowercase before storage. Lookups in
//     the rest of the code use lower(email), so case differences in
//     the input are absorbed.

import { Router } from "express";
import crypto from "node:crypto";
import { pool } from "../db/pool.js";
import { ValidationError, NotFoundError, ForbiddenError } from "../utils/errors.js";
import { requireUser, requireRole } from "../middleware/auth.js";
import { hash } from "../auth/passwords.js";
import { revokeAllForUser } from "../auth/tokens.js";
import { auditLog, diff } from "../audit/log.js";

const router = Router();
router.use(requireUser);
router.use(requireRole("admin"));

const ROLES = ["admin", "editor", "viewer"];
const STATUSES = ["active", "disabled"];

// ──────────────────────────────────────────────────────────────────────
// List
// ──────────────────────────────────────────────────────────────────────
router.get("/", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, email, role, status, display_name, last_login_at, created_at
         FROM users
        WHERE workspace_id = $1
        ORDER BY lower(email)`,
      [req.user.workspaceId],
    );
    res.json(rows);
  } catch (e) { next(e); }
});

// ──────────────────────────────────────────────────────────────────────
// Create
// ──────────────────────────────────────────────────────────────────────
router.post("/", async (req, res, next) => {
  try {
    const {
      email, password, role = "editor", displayName = null,
    } = req.body || {};
    validateEmail(email);
    validateRole(role);
    if (typeof password !== "string" || password.length < 8) {
      throw new ValidationError("password must be at least 8 characters");
    }

    const id = crypto.randomUUID();
    const ph = await hash(password);
    try {
      await pool.query(
        `INSERT INTO users (id, email, password_hash, role, workspace_id,
                            status, display_name)
         VALUES ($1, lower($2), $3, $4, $5, 'active', $6)`,
        [id, email, ph, role, req.user.workspaceId, displayName],
      );
      await pool.query(
        `INSERT INTO workspace_members (user_id, workspace_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, workspace_id) DO NOTHING`,
        [id, req.user.workspaceId, role],
      );
    } catch (e) {
      if (e.code === "23505") {
        throw new ValidationError(`a user with email "${email}" already exists`);
      }
      throw e;
    }
    await auditLog({
      req, action: "user.create",
      resource: { type: "user", id, name: email.toLowerCase() },
      metadata: { role, displayName: displayName || null },
    });
    res.status(201).json({ id, email: email.toLowerCase(), role });
  } catch (e) { next(e); }
});

// ──────────────────────────────────────────────────────────────────────
// Update — role / status / displayName
// ──────────────────────────────────────────────────────────────────────
router.put("/:id", async (req, res, next) => {
  try {
    const { role, status, displayName } = req.body || {};
    const target = await loadUser(req.params.id, req.user.workspaceId);
    if (!target) throw new NotFoundError("user");

    if (target.id === req.user.id && (role !== undefined || status !== undefined)) {
      throw new ForbiddenError("you cannot change your own role or status");
    }
    if (role !== undefined) validateRole(role);
    if (status !== undefined && !STATUSES.includes(status)) {
      throw new ValidationError(`status must be one of ${STATUSES.join(", ")}`);
    }

    // Last-admin safety: refuse anything that would leave the workspace
    // with zero active admins.
    const willChangeAdminPosture =
      (role !== undefined && target.role === "admin" && role !== "admin") ||
      (status !== undefined && target.role === "admin" && status === "disabled");
    if (willChangeAdminPosture) {
      const remainingAdmins = await countOtherActiveAdmins(req.user.workspaceId, target.id);
      if (remainingAdmins === 0) {
        throw new ForbiddenError(
          "cannot demote or disable the last active admin in this workspace",
        );
      }
    }

    const sets = [], params = [];
    if (role        !== undefined) { params.push(role);        sets.push(`role = $${params.length}`); }
    if (status      !== undefined) { params.push(status);      sets.push(`status = $${params.length}`); }
    if (displayName !== undefined) { params.push(displayName); sets.push(`display_name = $${params.length}`); }
    if (sets.length === 0) return res.json({ id: target.id, updated: false });
    params.push(target.id);
    const idIdx = params.length;
    params.push(req.user.workspaceId);
    const wsIdx = params.length;
    sets.push("updated_at = NOW()");
    await pool.query(
      `UPDATE users SET ${sets.join(", ")} WHERE id = $${idIdx} AND workspace_id = $${wsIdx}`,
      params,
    );
    // Disabling forces an immediate logout — the access token still has
    // up to ACCESS_TOKEN_TTL of life, but every refresh attempt will
    // now fail (requireUser checks status), and we kill the refresh
    // chain here as belt-and-braces.
    if (status === "disabled") await revokeAllForUser(target.id);

    await auditLog({
      req, action: "user.update",
      resource: { type: "user", id: target.id, name: target.email },
      metadata: {
        changes: diff(
          { role: target.role, status: target.status, display_name: target.display_name },
          { role: role ?? target.role, status: status ?? target.status, display_name: displayName ?? target.display_name },
        ),
      },
    });
    res.json({ id: target.id, updated: true });
  } catch (e) { next(e); }
});

// ──────────────────────────────────────────────────────────────────────
// Reset password (admin sets it directly — no email flow yet)
// ──────────────────────────────────────────────────────────────────────
router.post("/:id/password", async (req, res, next) => {
  try {
    const { password } = req.body || {};
    if (typeof password !== "string" || password.length < 8) {
      throw new ValidationError("password must be at least 8 characters");
    }
    const target = await loadUser(req.params.id, req.user.workspaceId);
    if (!target) throw new NotFoundError("user");

    const ph = await hash(password);
    await pool.query(
      "UPDATE users SET password_hash=$1, updated_at=NOW() WHERE id=$2 AND workspace_id=$3",
      [ph, target.id, req.user.workspaceId],
    );
    // Resetting a password should boot every active session — the new
    // owner of the password should be the only one logged in.
    await revokeAllForUser(target.id);
    await auditLog({
      req, action: "user.password.reset",
      resource: { type: "user", id: target.id, name: target.email },
    });
    res.json({ id: target.id, passwordReset: true });
  } catch (e) { next(e); }
});

// ──────────────────────────────────────────────────────────────────────
// Disable (soft delete) — same last-admin protection as PUT.
// ──────────────────────────────────────────────────────────────────────
router.delete("/:id", async (req, res, next) => {
  try {
    const target = await loadUser(req.params.id, req.user.workspaceId);
    if (!target) throw new NotFoundError("user");
    if (target.id === req.user.id) {
      throw new ForbiddenError("you cannot disable your own account");
    }
    if (target.role === "admin") {
      const remainingAdmins = await countOtherActiveAdmins(req.user.workspaceId, target.id);
      if (remainingAdmins === 0) {
        throw new ForbiddenError("cannot disable the last active admin");
      }
    }
    await pool.query(
      `UPDATE users SET status='disabled', updated_at=NOW()
        WHERE id=$1 AND workspace_id=$2`,
      [target.id, req.user.workspaceId],
    );
    await revokeAllForUser(target.id);
    await auditLog({
      req, action: "user.disable",
      resource: { type: "user", id: target.id, name: target.email },
    });
    res.json({ id: target.id, disabled: true });
  } catch (e) { next(e); }
});

// ──────────────────────────────────────────────────────────────────────
// helpers
// ──────────────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
function validateEmail(email) {
  if (typeof email !== "string" || !EMAIL_RE.test(email.trim())) {
    throw new ValidationError("a valid email is required");
  }
}
function validateRole(role) {
  if (!ROLES.includes(role)) {
    throw new ValidationError(`role must be one of ${ROLES.join(", ")}`);
  }
}

async function loadUser(id, workspaceId) {
  const { rows } = await pool.query(
    `SELECT id, email, role, status, display_name
       FROM users WHERE id=$1 AND workspace_id=$2`,
    [id, workspaceId],
  );
  return rows[0] || null;
}

async function countOtherActiveAdmins(workspaceId, excludeUserId) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM users
      WHERE workspace_id=$1 AND role='admin' AND status='active' AND id<>$2`,
    [workspaceId, excludeUserId],
  );
  return rows[0]?.n || 0;
}

export default router;
