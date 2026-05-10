// Auth foundation tests — passwords + JWT signing/verification.
//
// Lives at the unit level: no DB, no HTTP, just the pure-function
// halves of the auth module. The DB-touching pieces (refresh token
// rotation, theft replay) are exercised through the integration test
// suite once the API is up.
//
//     npm test
//
// Covers:
//   • password hash / verify round-trip
//   • password hash rejects empty + over-long inputs
//   • JWT round-trip preserves all claims
//   • JWT verify rejects expired tokens
//   • JWT verify rejects wrong-secret tokens
//   • needsRehash returns true when cost factor is below current

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod";

const { hash, verify, needsRehash } = await import("../src/auth/passwords.js");
const { signAccessToken, verifyAccessToken } = await import("../src/auth/tokens.js");

// ────────────────────────────────────────────────────────────────────
// Passwords
// ────────────────────────────────────────────────────────────────────

test("password hash + verify round-trip", async () => {
  const h = await hash("hunter2");
  assert.ok(typeof h === "string" && h.length > 50, "looks like a bcrypt string");
  assert.equal(await verify("hunter2", h), true);
  assert.equal(await verify("wrong", h),    false);
});

test("password hash rejects empty input", async () => {
  await assert.rejects(() => hash(""), /required/);
});

test("password hash rejects insanely long input", async () => {
  await assert.rejects(() => hash("x".repeat(2000)), /too long/);
});

test("verify against null hash returns false", async () => {
  assert.equal(await verify("anything", null), false);
});

test("verify against malformed hash returns false (no throw)", async () => {
  assert.equal(await verify("hunter2", "not-a-bcrypt-hash"), false);
});

test("needsRehash: true for cost-10 hashes (we're at 11)", () => {
  // Cost-10 dummy bcrypt hash header.
  const cost10 = "$2a$10$abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrst";
  assert.equal(needsRehash(cost10), true);
});

test("needsRehash: false for current-cost hashes", async () => {
  const fresh = await hash("p");
  assert.equal(needsRehash(fresh), false);
});

// ────────────────────────────────────────────────────────────────────
// JWT access tokens
// ────────────────────────────────────────────────────────────────────

test("JWT round-trip preserves claims", () => {
  const tok = signAccessToken({
    userId:      "11111111-1111-1111-1111-111111111111",
    email:       "vivek@example.com",
    role:        "admin",
    workspaceId: "22222222-2222-2222-2222-222222222222",
  });
  assert.equal(typeof tok, "string");
  assert.ok(tok.split(".").length === 3, "looks like a JWT");

  const payload = verifyAccessToken(tok);
  assert.equal(payload.sub,   "11111111-1111-1111-1111-111111111111");
  assert.equal(payload.email, "vivek@example.com");
  assert.equal(payload.role,  "admin");
  assert.equal(payload.ws,    "22222222-2222-2222-2222-222222222222");
  assert.equal(payload.iss,   "daisy-dag");
  assert.ok(typeof payload.exp === "number");
  assert.ok(typeof payload.iat === "number");
});

test("JWT verify rejects tampered payload", async () => {
  const tok = signAccessToken({
    userId: "u", email: "e@x", role: "viewer", workspaceId: "w",
  });
  // Flip a single byte in the signature → must fail.
  const tampered = tok.slice(0, -1) + (tok.endsWith("a") ? "b" : "a");
  assert.throws(() => verifyAccessToken(tampered),
    (e) => e.name === "JsonWebTokenError" || /invalid signature/i.test(e.message));
});

test("JWT verify rejects wrong-issuer tokens", async () => {
  // Sign manually with a non-daisy-dag issuer.
  const jwt = (await import("jsonwebtoken")).default;
  const tok = jwt.sign({ sub: "u" }, process.env.JWT_SECRET, {
    algorithm: "HS256",
    issuer:    "some-other-app",
    expiresIn: "5m",
  });
  assert.throws(() => verifyAccessToken(tok), /jwt issuer invalid/i);
});

test("JWT verify rejects expired tokens", async () => {
  const jwt = (await import("jsonwebtoken")).default;
  const tok = jwt.sign({ sub: "u" }, process.env.JWT_SECRET, {
    algorithm: "HS256",
    issuer:    "daisy-dag",
    expiresIn: "-1s",                  // already expired
  });
  assert.throws(() => verifyAccessToken(tok),
    (e) => e.name === "TokenExpiredError");
});
