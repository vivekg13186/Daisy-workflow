// Retention tests — exercise the policy + runner against a stubbed
// pool. We don't spin up Postgres for this: each test installs a
// fake `pool.query` (via Node's experimental test-module-mocks) that
// captures the SQL + params and returns a chosen rowCount.
//
//     npm test
//
// What we verify:
//   • The SQL shape and parameter binding are stable (catches typos
//     and accidental column-name drift).
//   • LIMIT is honored — every DELETE statement contains LIMIT $N.
//   • runAll drains policies that report "more remaining" until they
//     stop, capped by RETENTION_MAX_PASSES.
//   • Errors in one policy don't abort the others.

import { test, mock } from "node:test";
import assert from "node:assert/strict";

// Env affects retention/runner.js DEFAULTS (read at module load).
process.env.RETENTION_ENABLED          = "false";       // tests drive runAll() directly
process.env.RETENTION_BATCH_LIMIT      = "100";
process.env.RETENTION_MAX_PASSES       = "5";
process.env.RETENTION_EXECUTIONS_SUCCESS_DAYS = "90";
process.env.RETENTION_EXECUTIONS_FAILED_DAYS  = "180";

// Build a fake pool whose `.query` is a controllable mock. The module
// mock has to be in place BEFORE policies.js is imported, and
// Node's mock.module() only fires once per session — so all state
// has to thread through the FIFO queue + the shared `calls` array.
//
// Encode "throw on this call" via a marker object { __throw: Error }
// so a test that wants partial-failure semantics doesn't need to
// re-mock the module.
const calls = [];
let nextRowCounts = [];                 // FIFO queue of rowCounts to return

mock.module("../src/db/pool.js", {
  namedExports: {
    pool: {
      async query(sql, params) {
        calls.push({ sql, params });
        const next = nextRowCounts.length ? nextRowCounts.shift() : 0;
        if (next && typeof next === "object" && next.__throw) {
          throw next.__throw;
        }
        return { rowCount: next, rows: [] };
      },
    },
  },
});

const {
  pruneExecutions, pruneRefreshTokens, pruneConversationHistory,
} = await import("../src/retention/policies.js");
const { runAll, getConfig } = await import("../src/retention/runner.js");

function reset() { calls.length = 0; nextRowCounts = []; }

// ────────────────────────────────────────────────────────────────────
// policies.js — SQL shape
// ────────────────────────────────────────────────────────────────────

test("pruneExecutions: two DELETEs (success window + failed window)", async () => {
  reset();
  nextRowCounts = [12, 4];                   // success then failed
  const r = await pruneExecutions({
    successDays: 90, failedDays: 180, limit: 100,
  });

  assert.equal(calls.length, 2);
  // First call = success window.
  assert.match(calls[0].sql, /status = 'success'/);
  assert.match(calls[0].sql, /LIMIT \$2/);
  assert.deepEqual(calls[0].params, ["90 days", 100]);
  // Second call = failed window with the longer interval.
  assert.match(calls[1].sql, /status <> 'success'/);
  assert.deepEqual(calls[1].params, ["180 days", 100]);

  assert.equal(r.successDeleted, 12);
  assert.equal(r.failedDeleted,   4);
  assert.equal(r.total,          16);
});

test("pruneRefreshTokens: covers both revoked and expired in one DELETE", async () => {
  reset();
  nextRowCounts = [7];
  const n = await pruneRefreshTokens({ days: 30, limit: 100 });

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /revoked_at IS NOT NULL OR expires_at < NOW/);
  assert.match(calls[0].sql, /LIMIT \$2/);
  assert.deepEqual(calls[0].params, ["30 days", 100]);
  assert.equal(n, 7);
});

test("pruneConversationHistory: ROW_NUMBER partition with rn > keepTurns", async () => {
  reset();
  nextRowCounts = [42];
  const n = await pruneConversationHistory({ keepTurns: 50, limit: 100 });

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /namespace = 'history'/);
  assert.match(calls[0].sql, /ROW_NUMBER\(\)/);
  // First param is keepTurns; second is the LIMIT.
  assert.deepEqual(calls[0].params, [50, 100]);
  assert.equal(n, 42);
});

// ────────────────────────────────────────────────────────────────────
// runner.js — runAll aggregation + drain semantics
// ────────────────────────────────────────────────────────────────────

test("runAll: aggregates counts across policies", async () => {
  reset();
  // pruneExecutions  → 2 sub-DELETEs (success / failed)
  // pruneRefreshTokens → 1 DELETE
  // pruneConversationHistory → 1 DELETE
  // 4 calls in one pass.
  nextRowCounts = [5, 2, 9, 14];
  const r = await runAll();

  assert.equal(r.executions.successDeleted,   5);
  assert.equal(r.executions.failedDeleted,    2);
  assert.equal(r.executions.total,            7);
  assert.equal(r.refreshTokens.deleted,       9);
  assert.equal(r.history.deleted,            14);
  assert.equal(r.errors.length,               0);
});

test("runAll: drains a policy that keeps hitting the batch limit", async () => {
  reset();
  // BATCH_LIMIT=100. Make pruneExecutions saturate the limit on the
  // first two attempts then taper off — both success + failed should
  // each return 100 the first time, then 30 / 0 the second time.
  // After that refresh + history each settle at 0.
  nextRowCounts = [
    // Pass 1: success=100, failed=100  (success+failed total = 200 ≥ 100 → drain)
    100, 100,
    // Pass 2: success=30, failed=0     (total = 30 < 100 → done)
    30, 0,
    // refresh + history
    0, 0,
  ];
  const r = await runAll();

  // 2 passes for executions
  assert.equal(r.executions.passes,           2);
  assert.equal(r.executions.successDeleted, 130);
  assert.equal(r.executions.failedDeleted,  100);
  assert.equal(r.executions.total,          230);
});

test("runAll: one policy throwing doesn't stop the others", async () => {
  reset();
  // Throw on the FIRST DELETE (executions/success). The drainPass
  // helper catches per-policy, records the error, and moves on.
  // Refresh tokens + history still run.
  nextRowCounts = [
    { __throw: new Error("synthetic-success-throw") },  // executions success
    // executions failed never runs because drainPass returns early
    // after the success step throws.
    3,                                                  // refresh tokens
    3,                                                  // history
  ];
  const r = await runAll();

  assert.ok(r.errors.length >= 1, "first failure captured");
  assert.match(r.errors[0].message, /synthetic-success-throw/);
  assert.equal(r.refreshTokens.deleted, 3);
  assert.equal(r.history.deleted,       3);
});

// ────────────────────────────────────────────────────────────────────
// runner.js — getConfig surface
// ────────────────────────────────────────────────────────────────────

test("getConfig: env values are parsed at module load", () => {
  const c = getConfig();
  assert.equal(c.enabled,          false);
  assert.equal(c.batchLimit,       100);
  assert.equal(c.maxPasses,        5);
  assert.equal(c.successDays,      90);
  assert.equal(c.failedDays,       180);
});
