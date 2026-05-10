// Authentication endpoints.
//
//   POST /auth/login    — email + password → access JWT + refresh cookie
//   POST /auth/refresh  — uses refresh cookie → new access JWT + rotated cookie
//   POST /auth/logout   — revokes refresh token + clears cookie
//   GET  /auth/me       — current user info (requires bearer)
//   GET  /auth/config   — public discovery (advertises OIDC if configured)
//
// All four mutating endpoints are mounted UNDER /auth, which is also
// the cookie path so the refresh cookie isn't sent on /graphs etc.
//
// Logging note:
//   Failed logins always return 401 with the same body regardless of
//   whether the user exists or the password was wrong — this avoids
//   user-enumeration via timing or response shape. The structured log
//   line on failure DOES include enough context for an admin to
//   investigate (email + outcome).

import { Router } from "express";
import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { log } from "../utils/logger.js";
import { ValidationError, UnauthorizedError } from "../utils/errors.js";
import { hash, verify, needsRehash } from "../auth/passwords.js";
import {
  signAccessToken,
  issueRefreshToken,
  consumeRefreshToken,
  revokeRefreshToken,
  REFRESH_COOKIE,
  refreshCookieOptions,
} from "../auth/tokens.js";
import { requireUser } from "../middleware/auth.js";

const router = Router();

// ────────────────────────────────────────────────────────────────────
// GET /auth/config — public, no auth.
//
// Lets the frontend ask "is OIDC available, what's the SSO button
// label?" before painting the login screen. Returns nothing sensitive.
// ────────────────────────────────────────────────────────────────────
router.get("/config", (_req, res) => {
  const oidcEnabled = !!process.env.OIDC_ISSUER_URL;
  res.json({
    localEnabled: true,
    oidcEnabled,
    oidcLabel: process.env.OIDC_BUTTON_LABEL || "Sign in with SSO",
  });
});

// ────────────────────────────────────────────────────────────────────
// POST /auth/login   { email, password }
// ────────────────────────────────────────────────────────────────────
router.post("/login", async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (typeof email !== "string" || typeof password !== "string") {
      throw new ValidationError("email and password required");
    }
    const u = await findActiveUserByEmail(email);
    const ok = u && u.password_hash && await verify(password, u.password_hash);
    if (!ok) {
      log.warn("login failed", { email });
      // Single 401 shape regardless of which check failed.
      throw new UnauthorizedError("invalid credentials");
    }

    // Opportunistic rehash if we bumped the cost factor since this
    // hash was created. Keeps stored hashes current at zero user cost.
    if (needsRehash(u.password_hash)) {
      const fresh = await hash(password);
      await pool.query("UPDATE users SET password_hash=$1 WHERE id=$2",
        [fresh, u.id]);
    }

    await pool.query("UPDATE users SET last_login_at = NOW() WHERE id=$1", [u.id]);
    log.info("login ok", { userId: u.id, email: u.email });

    const tokens = await issueTokensFor(req, res, u);
    res.json(tokens);
  } catch (e) { next(e); }
});

// ────────────────────────────────────────────────────────────────────
// POST /auth/refresh   (uses cookie)
//
// Reads the refresh token from the cookie, rotates it (issues a new
// one, marks the old revoked + chained), and hands back a fresh
// access JWT. Theft-replay protection lives in consumeRefreshToken().
// ────────────────────────────────────────────────────────────────────
router.post("/refresh", async (req, res, next) => {
  try {
    const presented = req.cookies?.[REFRESH_COOKIE];
    if (!presented) throw new UnauthorizedError("missing refresh cookie");

    const consumed = await consumeRefreshToken(presented);
    if (!consumed) {
      // Either expired, revoked, or theft-replay (consume already
      // burned the user's chain in that case).
      res.clearCookie(REFRESH_COOKIE, refreshCookieOptions());
      throw new UnauthorizedError("refresh token invalid");
    }

    const { rows } = await pool.query(
      `SELECT id, email, role, workspace_id, status
         FROM users WHERE id = $1`,
      [consumed.userId],
    );
    if (rows.length === 0 || rows[0].status !== "active") {
      res.clearCookie(REFRESH_COOKIE, refreshCookieOptions());
      throw new UnauthorizedError("user not available");
    }
    const u = rows[0];

    const next = await issueRefreshToken({
      userId:        u.id,
      userAgent:     req.headers["user-agent"] || null,
      ip:            req.ip || null,
      predecessorId: consumed.id,
    });
    res.cookie(REFRESH_COOKIE, next.token, refreshCookieOptions());

    res.json({
      accessToken: signAccessToken({
        userId:      u.id,
        email:       u.email,
        role:        u.role,
        workspaceId: u.workspace_id,
      }),
      user: publicUser(u),
    });
  } catch (e) { next(e); }
});

// ────────────────────────────────────────────────────────────────────
// POST /auth/logout
//
// Best-effort revoke of the refresh cookie + clear it. Idempotent —
// always returns 204 even if the cookie was missing or already
// revoked, so the client UI doesn't hang on logout failures.
// ────────────────────────────────────────────────────────────────────
router.post("/logout", async (req, res, next) => {
  try {
    const presented = req.cookies?.[REFRESH_COOKIE];
    if (presented) await revokeRefreshToken(presented);
    res.clearCookie(REFRESH_COOKIE, refreshCookieOptions());
    res.status(204).end();
  } catch (e) { next(e); }
});

// ────────────────────────────────────────────────────────────────────
// GET /auth/me — requires Authorization: Bearer
//
// Returns the user object the frontend's auth store uses. Cheap
// (no DB hit beyond what requireUser already did).
// ────────────────────────────────────────────────────────────────────
router.get("/me", requireUser, async (req, res) => {
  res.json({
    id:          req.user.id,
    email:       req.user.email,
    role:        req.user.role,
    workspaceId: req.user.workspaceId,
    status:      req.user.status,
  });
});

// ────────────────────────────────────────────────────────────────────
// helpers
// ────────────────────────────────────────────────────────────────────

async function findActiveUserByEmail(email) {
  const { rows } = await pool.query(
    `SELECT id, email, role, workspace_id, status, password_hash
       FROM users
      WHERE lower(email) = lower($1) AND status = 'active'
      LIMIT 1`,
    [email],
  );
  return rows[0] || null;
}

async function issueTokensFor(req, res, u) {
  const accessToken = signAccessToken({
    userId:      u.id,
    email:       u.email,
    role:        u.role,
    workspaceId: u.workspace_id,
  });
  const refresh = await issueRefreshToken({
    userId:    u.id,
    userAgent: req.headers["user-agent"] || null,
    ip:        req.ip || null,
  });
  res.cookie(REFRESH_COOKIE, refresh.token, refreshCookieOptions());
  return {
    accessToken,
    user: publicUser(u),
  };
}

function publicUser(u) {
  return {
    id:          u.id,
    email:       u.email,
    role:        u.role,
    workspaceId: u.workspace_id,
    status:      u.status,
  };
}

export default router;
