// Rate-limit module tests.
//
// We don't spin up Redis or Express here — the actual limiting
// behaviour is well-tested by express-rate-limit + rate-limit-redis
// upstream. What we DO test:
//
//   • The env-driven limit values land on getLimits().
//   • The disabled mode (RATE_LIMIT_ENABLED=false) returns no-op
//     middleware that calls next() without touching anything.
//   • All seven named limiters exist on the exported object.
//
// To keep the test self-contained, RATE_LIMIT_ENABLED=false is set
// BEFORE the module is imported — that way the Redis store isn't
// constructed and we don't need an ioredis stub.

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.RATE_LIMIT_ENABLED        = "false";
process.env.RATE_LIMIT_GLOBAL_PER_MIN = "999";
process.env.RATE_LIMIT_LOGIN_PER_MIN  = "7";

const { limiters, getLimits } = await import("../src/middleware/rateLimit.js");

test("getLimits: env values override defaults", () => {
  const limits = getLimits();
  assert.equal(limits.global, 999);
  assert.equal(limits.login,  7);
  // Unset ones keep their defaults.
  assert.equal(limits.refresh,      30);
  assert.equal(limits.execute,      60);
  assert.equal(limits.ai,           30);
  assert.equal(limits.webhook,      60);
  assert.equal(limits.loginByEmail, 5);
});

test("disabled mode: every limiter is a no-op middleware", () => {
  const names = ["global", "login", "loginByEmail", "refresh", "execute", "ai", "webhook"];
  for (const name of names) {
    const mw = limiters[name];
    assert.equal(typeof mw, "function", `limiters.${name} should be a middleware`);
    // Synchronously calls next; doesn't touch req/res.
    let calledNext = false;
    mw({}, {}, () => { calledNext = true; });
    assert.equal(calledNext, true, `limiters.${name} should call next`);
  }
});

test("all seven named limiters are exported", () => {
  assert.deepEqual(
    Object.keys(limiters).sort(),
    ["ai", "execute", "global", "login", "loginByEmail", "refresh", "webhook"],
  );
});
