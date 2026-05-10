// Workspaces API.
//
// Scope:
//   • Any signed-in user can GET /workspaces — returns the workspaces
//     they belong to (membership is via users.workspace_id OR
//     workspace_members). The current/active workspace is the one in
//     the JWT's `ws` claim.
//
//   • Admin-only operations:
//       - PUT /workspaces/:id   rename
//       - GET /workspaces/:id/members   list members + their roles
//
//   • POST /workspaces is intentionally NOT exposed in this PR. New
//     workspace creation is a privileged operation that gets an
//     existence check (uniqueness, billing in production setups) we
//     don't want to bake in early. The bootstrap CLI is the path.
//
//   • Workspace SWITCHING — the JWT carries `ws`, so a switch is
//     "issue a new access token with a different ws claim". POST
//     /workspaces/:id/switch handles that, scoped to workspaces the
//     caller actually belongs to.

import { Router } from "express";
import { pool } from "../db/pool.js";
import { ValidationError, NotFoundError, ForbiddenError } from "../utils/errors.js";
import { requireUser, requireRole } from "../middleware/auth.js";
import { signAccessToken } from "../auth/tokens.js";

const router = Router();
router.use(requireUser);

// ──────────────────────────────────────────────────────────────────────
// GET /workspaces — list workspaces the caller is a member of.
//
// "Member of" = primary workspace (users.workspace_id) PLUS any rows
// in workspace_members. The primary lands in the result with
// `primary: true` so the UI can render it differently (e.g. as the
// default option in a switcher).
// ──────────────────────────────────────────────────────────────────────
router.get("/", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT w.id, w.name, w.slug,
              (w.id = u.workspace_id) AS primary,
              COALESCE(wm.role, u.role) AS role,
              w.created_at
         FROM users u
         JOIN workspaces w
           ON w.id = u.workspace_id
            OR w.id IN (SELECT workspace_id FROM workspace_members WHERE user_id = u.id)
    LEFT JOIN workspace_members wm
           ON wm.user_id = u.id AND wm.workspace_id = w.id
        WHERE u.id = $1
        ORDER BY w.name`,
      [req.user.id],
    );
    res.json({
      active: req.user.workspaceId,
      workspaces: rows,
    });
  } catch (e) { next(e); }
});

// ──────────────────────────────────────────────────────────────────────
// GET /workspaces/:id — single workspace (only one the caller belongs to).
// ──────────────────────────────────────────────────────────────────────
router.get("/:id", async (req, res, next) => {
  try {
    if (!await callerBelongsTo(req.user.id, req.params.id)) {
      throw new NotFoundError("workspace");
    }
    const { rows } = await pool.query(
      "SELECT id, name, slug, created_at, updated_at FROM workspaces WHERE id=$1",
      [req.params.id],
    );
    if (rows.length === 0) throw new NotFoundError("workspace");
    res.json(rows[0]);
  } catch (e) { next(e); }
});

// ──────────────────────────────────────────────────────────────────────
// GET /workspaces/:id/members — admin-only, list members.
// ──────────────────────────────────────────────────────────────────────
router.get("/:id/members", requireRole("admin"), async (req, res, next) => {
  try {
    // Admins can only list members of their own active workspace.
    if (req.params.id !== req.user.workspaceId) {
      throw new ForbiddenError("can only list members of your active workspace");
    }
    const { rows } = await pool.query(
      `SELECT u.id, u.email, u.display_name, u.status,
              u.last_login_at,
              COALESCE(wm.role, u.role) AS role,
              (u.workspace_id = $1) AS primary
         FROM users u
    LEFT JOIN workspace_members wm
           ON wm.user_id = u.id AND wm.workspace_id = $1
        WHERE u.workspace_id = $1
           OR u.id IN (SELECT user_id FROM workspace_members WHERE workspace_id = $1)
        ORDER BY lower(u.email)`,
      [req.params.id],
    );
    res.json(rows);
  } catch (e) { next(e); }
});

// ──────────────────────────────────────────────────────────────────────
// PUT /workspaces/:id — rename. Admin-only.
// ──────────────────────────────────────────────────────────────────────
router.put("/:id", requireRole("admin"), async (req, res, next) => {
  try {
    if (req.params.id !== req.user.workspaceId) {
      throw new ForbiddenError("can only rename your active workspace");
    }
    const { name } = req.body || {};
    if (typeof name !== "string" || !name.trim()) {
      throw new ValidationError("name is required");
    }
    await pool.query(
      "UPDATE workspaces SET name=$1, updated_at=NOW() WHERE id=$2",
      [name.trim(), req.params.id],
    );
    res.json({ id: req.params.id, renamed: true });
  } catch (e) { next(e); }
});

// ──────────────────────────────────────────────────────────────────────
// POST /workspaces/:id/switch — issue a new access token whose `ws`
// claim points at the chosen workspace. The refresh cookie is left
// untouched (it's user-bound, not workspace-bound).
// ──────────────────────────────────────────────────────────────────────
router.post("/:id/switch", async (req, res, next) => {
  try {
    const isMember = await callerBelongsTo(req.user.id, req.params.id);
    if (!isMember) throw new NotFoundError("workspace");

    // Look up the caller's role IN THE TARGET WORKSPACE — they may
    // be admin in their primary but only an editor in another team.
    const { rows: roleRows } = await pool.query(
      `SELECT COALESCE(wm.role, u.role) AS role
         FROM users u
    LEFT JOIN workspace_members wm
           ON wm.user_id = u.id AND wm.workspace_id = $2
        WHERE u.id = $1
        LIMIT 1`,
      [req.user.id, req.params.id],
    );
    const role = roleRows[0]?.role || req.user.role;

    const accessToken = signAccessToken({
      userId:      req.user.id,
      email:       req.user.email,
      role,
      workspaceId: req.params.id,
    });
    res.json({
      accessToken,
      user: {
        id:          req.user.id,
        email:       req.user.email,
        role,
        workspaceId: req.params.id,
        status:      req.user.status,
      },
    });
  } catch (e) { next(e); }
});

// ──────────────────────────────────────────────────────────────────────
// helpers
// ──────────────────────────────────────────────────────────────────────

async function callerBelongsTo(userId, workspaceId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM users
       WHERE id=$1 AND workspace_id=$2
      UNION ALL
      SELECT 1 FROM workspace_members
       WHERE user_id=$1 AND workspace_id=$2
      LIMIT 1`,
    [userId, workspaceId],
  );
  return rows.length > 0;
}

export default router;
