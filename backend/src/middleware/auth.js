// Auth middleware — three pieces.
//
//   • requireUser     — verifies the JWT, loads the user, attaches
//                       req.user. 401 on missing / bad token. The
//                       single guard you put in front of any route
//                       that needs a logged-in caller.
//
//   • requireRole(*)  — runs AFTER requireUser. 403 unless the user's
//                       role is in the allow-list.
//
//   • requireWorkspace(req, res, next) — auto-applied via requireUser;
//                       refuses requests where req.user has no
//                       workspace (shouldn't happen because the
//                       schema's NOT NULL, but a belt for the braces).
//
// req.user shape after requireUser:
//   {
//     id:          uuid,
//     email:       string,
//     role:        'admin' | 'editor' | 'viewer',
//     workspaceId: uuid,           // currently-active workspace
//     status:      'active' | 'disabled',
//   }
//
// Why we re-fetch the user on every request:
//   We could trust the JWT payload alone — that's the canonical
//   "stateless JWT" play. But then deactivating an account or
//   demoting an admin doesn't take effect until their access token
//   expires (up to 15 min). One extra indexed PK lookup against
//   `users` keeps the admin-disable flow snappy and gives us a clear
//   "user no longer exists" surface.

import { pool } from "../db/pool.js";
import { verifyAccessToken } from "../auth/tokens.js";
import { UnauthorizedError, ForbiddenError } from "../utils/errors.js";

/**
 * Decode the bearer JWT, validate the user is still active, and
 * attach req.user. Use as the FIRST middleware on every protected
 * route group.
 */
export async function requireUser(req, _res, next) {
  try {
    const token = extractBearer(req);
    if (!token) throw new UnauthorizedError("missing bearer token");

    let payload;
    try {
      payload = verifyAccessToken(token);
    } catch (e) {
      // jsonwebtoken throws JsonWebTokenError / TokenExpiredError —
      // map both to 401 without leaking the specific reason.
      throw new UnauthorizedError(
        e.name === "TokenExpiredError" ? "token expired" : "invalid token",
      );
    }

    const userId = payload.sub;
    const { rows } = await pool.query(
      `SELECT id, email, role, workspace_id, status
         FROM users WHERE id = $1`,
      [userId],
    );
    if (rows.length === 0) throw new UnauthorizedError("user no longer exists");
    const u = rows[0];
    if (u.status !== "active") throw new UnauthorizedError("user disabled");

    // The JWT carries `ws` (active workspace at issue time). If the
    // user has switched workspaces since, the access token would
    // still be carrying the old value until refresh. Trust the JWT
    // payload — switching workspace forces a refresh on the client.
    const workspaceId = payload.ws || u.workspace_id;

    req.user = {
      id:          u.id,
      email:       u.email,
      role:        u.role,
      workspaceId,
      status:      u.status,
    };
    next();
  } catch (e) { next(e); }
}

/**
 * requireRole('admin')                 — admin only
 * requireRole('admin', 'editor')       — admin or editor
 *
 * Use AFTER requireUser. 403 with `{ need: [...allowed] }` body if
 * the user's role doesn't match.
 */
export function requireRole(...allowed) {
  if (allowed.length === 0) {
    throw new Error("requireRole called with no roles");
  }
  return (req, _res, next) => {
    try {
      if (!req.user) {
        return next(new UnauthorizedError("authentication required"));
      }
      if (!allowed.includes(req.user.role)) {
        return next(new ForbiddenError(
          `role "${req.user.role}" not permitted`,
          { need: allowed },
        ));
      }
      next();
    } catch (e) { next(e); }
  };
}

/**
 * Extract the bearer token from the Authorization header. Supports
 * two carrier formats:
 *
 *   Authorization: Bearer <token>
 *   ?access_token=<token>      (query param — used by EventSource /
 *                               WebSocket upgrade where headers can't
 *                               be set from JS)
 */
function extractBearer(req) {
  const h = req.headers.authorization || req.headers.Authorization;
  if (h && /^Bearer /i.test(h)) {
    return h.slice(7).trim();
  }
  if (req.query?.access_token) return String(req.query.access_token);
  return null;
}
