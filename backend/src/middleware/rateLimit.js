// Rate limiting — preconfigured express-rate-limit middlewares
// backed by the same ioredis connection BullMQ uses.
//
// Why Redis-backed:
//   With an in-memory store, two API instances each count requests
//   separately, so a 10/min limit becomes 20/min as soon as you
//   scale out. The Redis store puts the counters in a shared
//   place; limits are correct regardless of how many API processes
//   are running.
//
// Why opt-out via env:
//   The test suite hits its own endpoints fast enough to trip
//   real limits. Setting RATE_LIMIT_ENABLED=false bypasses every
//   limiter at module load — they become no-op middlewares. The
//   bypass is module-level (not per-request) so there's zero
//   measurable cost when disabled.
//
// Limiter taxonomy:
//   • global      every authenticated + public request, per IP
//   • login       /auth/login, per IP (anti-brute-force)
//   • loginByEmail /auth/login, per attempted email
//                 (anti-credential-stuffing across IPs)
//   • refresh     /auth/refresh, per IP
//   • execute     POST /graphs/:id/execute, per user
//   • ai          /ai/chat + /ai/agent/chat, per user
//   • webhook     /webhooks/:id, per IP + per webhook id
//
// Each limiter returns 429 with:
//
//     { "error": "RATE_LIMITED",
//       "message": "Too many requests, slow down.",
//       "retryAfter": <seconds> }
//
// plus a `Retry-After` header (RFC 6585). The body is JSON because
// the frontend's axios interceptor can detect and surface it as a
// toast.

import { rateLimit } from "express-rate-limit";
import RedisStore from "rate-limit-redis";
import { redisConnection } from "../queue/queue.js";
import { log } from "../utils/logger.js";

const ENABLED = String(process.env.RATE_LIMIT_ENABLED ?? "true").toLowerCase() !== "false";

// ────────────────────────────────────────────────────────────────────
// Env-driven thresholds. Sane defaults that legitimate use won't
// trip; tighten them in production envs that face the open internet.
// ────────────────────────────────────────────────────────────────────

function n(name, fallback) {
  const v = process.env[name];
  if (v == null || v === "") return fallback;
  const x = parseInt(v, 10);
  return Number.isFinite(x) && x > 0 ? x : fallback;
}

const LIMITS = Object.freeze({
  global:        n("RATE_LIMIT_GLOBAL_PER_MIN",         600),
  login:         n("RATE_LIMIT_LOGIN_PER_MIN",           10),
  loginByEmail:  n("RATE_LIMIT_LOGIN_PER_EMAIL_PER_MIN",  5),
  refresh:       n("RATE_LIMIT_REFRESH_PER_MIN",         30),
  execute:       n("RATE_LIMIT_EXECUTE_PER_MIN",         60),
  ai:            n("RATE_LIMIT_AI_PER_MIN",              30),
  webhook:       n("RATE_LIMIT_WEBHOOK_PER_MIN",         60),
});
export function getLimits() { return LIMITS; }

// ────────────────────────────────────────────────────────────────────
// Bypass — exported as plain middleware so disabled callers don't
// need to add their own conditionals.
// ────────────────────────────────────────────────────────────────────

const noop = (_req, _res, next) => next();

if (!ENABLED) {
  log.info("rate limiting disabled (RATE_LIMIT_ENABLED=false)");
}

// ────────────────────────────────────────────────────────────────────
// Builder — produces a rate-limit middleware with a Redis-backed
// store and our default 429 response shape.
// ────────────────────────────────────────────────────────────────────

function make({ windowMs = 60_000, max, keyGenerator, message }) {
  if (!ENABLED) return noop;
  // rate-limit-redis adapter — `sendCommand` is the ioredis-style
  // call it uses internally. Each limiter shares the connection but
  // its own key prefix so different rules don't collide.
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders:   false,
    keyGenerator,
    store: new RedisStore({
      sendCommand: (...args) => redisConnection.call(...args),
      prefix: `daisy:rl:${message}:`,
    }),
    // Custom 429 body so the frontend's axios layer can detect it
    // by error.response.data.error === "RATE_LIMITED" rather than
    // sniffing on status alone.
    handler: (_req, res /*, next, options*/) => {
      const retryAfter = res.getHeader("Retry-After");
      res.status(429).json({
        error:   "RATE_LIMITED",
        message: "Too many requests. Slow down.",
        retryAfter: retryAfter ? Number(retryAfter) : undefined,
      });
    },
  });
}

// ────────────────────────────────────────────────────────────────────
// Pre-built limiters — import the one your route needs.
//
// Key generators:
//   • IP-based:    custom helper. For IPv4 we use the raw address.
//                  For IPv6 we collapse to the /64 prefix so an
//                  attacker can't churn through addresses inside a
//                  single allocation to bypass per-IP limits (most
//                  IPv6 ISPs hand out /64s as a unit). The upstream
//                  package ships an `ipKeyGenerator` helper that
//                  does the same thing, but its export shape moves
//                  across patch versions so we keep it inline.
//   • email-based: lower-cased + trimmed so "VIVEK" and " vivek "
//                  share a bucket.
//   • user-based:  req.user.id when present; falls back to IP for
//                  unauthenticated requests (shouldn't happen on
//                  protected routes but better to limit than not).
// ────────────────────────────────────────────────────────────────────

function ipKeyOf(req) {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  // IPv6 → collapse to /64 (first four hextets).
  if (ip.includes(":")) {
    const hextets = ip.split(":").slice(0, 4);
    while (hextets.length < 4) hextets.push("0");
    return hextets.join(":") + "::/64";
  }
  return ip;
}

const ipKey      = (req) => ipKeyOf(req);
const userKey    = (req) => req.user?.id ? `u:${req.user.id}` : ipKey(req);
const emailKey   = (req) => {
  const e = String(req.body?.email || "").trim().toLowerCase();
  return e ? `e:${e}` : ipKey(req);
};
const webhookKey = (req) =>
  `w:${req.params?.id || req.params?.webhookId || "unknown"}:${ipKey(req)}`;

export const limiters = {
  // Per-IP catch-all. Generous enough that ordinary clients never
  // see it; tight enough that a single attacker can't sustain a
  // synthetic flood against the whole API.
  global:        make({ max: LIMITS.global,       keyGenerator: ipKey,      message: "global" }),
  login:         make({ max: LIMITS.login,        keyGenerator: ipKey,      message: "login" }),
  loginByEmail:  make({ max: LIMITS.loginByEmail, keyGenerator: emailKey,   message: "loginEmail" }),
  refresh:       make({ max: LIMITS.refresh,      keyGenerator: ipKey,      message: "refresh" }),
  execute:       make({ max: LIMITS.execute,      keyGenerator: userKey,    message: "execute" }),
  ai:            make({ max: LIMITS.ai,           keyGenerator: userKey,    message: "ai" }),
  webhook:       make({ max: LIMITS.webhook,      keyGenerator: webhookKey, message: "webhook" }),
};
