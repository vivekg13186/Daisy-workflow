// Execution-limits tests.
//
// Covers the pure helpers in src/engine/limits.js — no DB, no
// queue, no engine. Just the duration parser, the layered resolver
// chain, the retry clamp, and the withTimeout race semantics.
//
//     npm test

import { test } from "node:test";
import assert from "node:assert/strict";

// Make the env predictable BEFORE importing the module — DEFAULTS are
// read at module load.
process.env.EXECUTION_DEFAULT_NODE_TIMEOUT     = "2s";
process.env.EXECUTION_DEFAULT_WORKFLOW_TIMEOUT = "1m";
process.env.EXECUTION_MAX_RETRIES              = "5";
process.env.EXECUTION_MAX_ITERATIONS           = "100";
process.env.EXECUTION_MAX_TOKENS               = "1000";

const {
  parseDurationMs,
  getDefaults,
  resolveNodeTimeoutMs,
  resolveWorkflowTimeoutMs,
  resolveMaxRetries,
  resolveMaxIterations,
  resolveMaxTokens,
  assertIterationCap,
  chargeTokens,
  withTimeout,
  NodeTimeoutError,
  WorkflowTimeoutError,
  IterationCapError,
  BudgetExhaustedError,
} = await import("../src/engine/limits.js");

// ────────────────────────────────────────────────────────────────────
// Duration parsing
// ────────────────────────────────────────────────────────────────────

test("parseDurationMs: numeric ms passthrough", () => {
  assert.equal(parseDurationMs(0),    0);
  assert.equal(parseDurationMs(1500), 1500);
});

test("parseDurationMs: string units", () => {
  assert.equal(parseDurationMs("500ms"), 500);
  assert.equal(parseDurationMs("2s"),    2000);
  assert.equal(parseDurationMs("3m"),    180_000);
  assert.equal(parseDurationMs("1h"),    3_600_000);
  assert.equal(parseDurationMs("42"),    42);     // bare number = ms
});

test("parseDurationMs: invalid → null (so callers can fall back)", () => {
  assert.equal(parseDurationMs(""),    null);
  assert.equal(parseDurationMs(null),  null);
  assert.equal(parseDurationMs("x"),   null);
  assert.equal(parseDurationMs(-1),    null);
  assert.equal(parseDurationMs(NaN),   null);
});

// ────────────────────────────────────────────────────────────────────
// Defaults from env
// ────────────────────────────────────────────────────────────────────

test("env defaults: parsed at module load", () => {
  const d = getDefaults();
  assert.equal(d.nodeTimeoutMs,     2_000);
  assert.equal(d.workflowTimeoutMs, 60_000);
  assert.equal(d.maxRetries,        5);
  assert.equal(d.maxIterations,     100);
  assert.equal(d.maxTokens,         1_000);
});

// ────────────────────────────────────────────────────────────────────
// Layered resolution
// ────────────────────────────────────────────────────────────────────

test("resolveNodeTimeoutMs: per-node beats per-workflow beats default", () => {
  const parsed = { nodeTimeout: "10s" };
  // Per-node set → wins.
  assert.equal(resolveNodeTimeoutMs({ timeout: "500ms" }, parsed), 500);
  // Per-node unset, workflow set → workflow.
  assert.equal(resolveNodeTimeoutMs({}, parsed), 10_000);
  // Both unset → env default.
  assert.equal(resolveNodeTimeoutMs({}, {}), 2_000);
});

test("resolveWorkflowTimeoutMs: workflow DSL > env default", () => {
  assert.equal(resolveWorkflowTimeoutMs({ timeout: "5m" }), 300_000);
  assert.equal(resolveWorkflowTimeoutMs({}),                60_000);
});

// ────────────────────────────────────────────────────────────────────
// Retry clamp
// ────────────────────────────────────────────────────────────────────

test("resolveMaxRetries: clamps to EXECUTION_MAX_RETRIES", () => {
  assert.equal(resolveMaxRetries(0),     0);
  assert.equal(resolveMaxRetries(3),     3);
  assert.equal(resolveMaxRetries(5),     5);
  assert.equal(resolveMaxRetries(50),    5);    // clamp
  assert.equal(resolveMaxRetries(9999),  5);    // clamp
});

test("resolveMaxRetries: non-numeric / negative → 0", () => {
  assert.equal(resolveMaxRetries(undefined), 0);
  assert.equal(resolveMaxRetries(null),      0);
  assert.equal(resolveMaxRetries("nope"),    0);
  assert.equal(resolveMaxRetries(-1),        0);
});

// ────────────────────────────────────────────────────────────────────
// withTimeout
// ────────────────────────────────────────────────────────────────────

test("withTimeout: fast promise wins, no timer fires", async () => {
  const result = await withTimeout(
    Promise.resolve("ok"),
    50,
    () => new Error("should not happen"),
  );
  assert.equal(result, "ok");
});

test("withTimeout: slow promise loses, error thrown", async () => {
  const slow = new Promise(r => setTimeout(() => r("late"), 100));
  await assert.rejects(
    () => withTimeout(slow, 20, () => new NodeTimeoutError("X", 20)),
    (err) => err instanceof NodeTimeoutError && err.timeoutMs === 20,
  );
});

test("withTimeout: rejecting promise rejects normally before the timer", async () => {
  const failing = Promise.reject(new Error("boom"));
  await assert.rejects(
    () => withTimeout(failing, 50, () => new Error("timeout shouldn't win")),
    /boom/,
  );
});

test("withTimeout: ms <= 0 or null disables the budget", async () => {
  const slow = new Promise(r => setTimeout(() => r("done"), 10));
  // null → no timeout
  assert.equal(await withTimeout(slow, null, () => new Error("nope")), "done");
});

test("WorkflowTimeoutError carries the budget for the worker error path", () => {
  const e = new WorkflowTimeoutError(30_000);
  assert.equal(e.code,       "WORKFLOW_TIMEOUT");
  assert.equal(e.timeoutMs,  30_000);
  assert.match(e.message,    /30000ms/);
});

// ────────────────────────────────────────────────────────────────────
// Iteration cap (PR 7.6)
// ────────────────────────────────────────────────────────────────────

test("resolveMaxIterations: workflow override beats env default", () => {
  assert.equal(resolveMaxIterations({ maxIterations: 25 }), 25);
  assert.equal(resolveMaxIterations({}),                    100);
});

test("assertIterationCap: under the cap is a no-op", () => {
  assertIterationCap({}, 50,  "test");          // 50 < 100 — fine
  assertIterationCap({}, 100, "test");          // exactly cap — fine
});

test("assertIterationCap: over the cap throws IterationCapError", () => {
  assert.throws(
    () => assertIterationCap({}, 101, "executeBatch"),
    (err) => err instanceof IterationCapError
          && err.count === 101
          && err.max   === 100
          && err.where === "executeBatch",
  );
});

// ────────────────────────────────────────────────────────────────────
// Token budget (PR 7.7)
// ────────────────────────────────────────────────────────────────────

test("resolveMaxTokens: workflow override beats env default", () => {
  assert.equal(resolveMaxTokens({ maxTokens: 500 }), 500);
  assert.equal(resolveMaxTokens({}),                 1_000);
});

test("chargeTokens: accumulates across calls", () => {
  const ctx = {};
  assert.equal(chargeTokens(ctx, {}, 100), 100);
  assert.equal(chargeTokens(ctx, {}, 250), 350);
  assert.equal(ctx._tokens,                350);
});

test("chargeTokens: throws BudgetExhaustedError when the running total crosses max", () => {
  const ctx = { _tokens: 950 };
  assert.throws(
    () => chargeTokens(ctx, {}, 200),                  // 950 + 200 = 1150 > 1000
    (err) => err instanceof BudgetExhaustedError
          && err.used >= 1000
          && err.max  === 1000
          && err.kind === "tokens",
  );
});

test("chargeTokens: workflow override of maxTokens applies", () => {
  const ctx = {};
  assert.throws(
    () => chargeTokens(ctx, { maxTokens: 50 }, 100),
    (err) => err instanceof BudgetExhaustedError && err.max === 50,
  );
});

test("chargeTokens: 0 / undefined max disables the check", () => {
  const ctx = {};
  // maxTokens: 0 → unlimited
  assert.equal(chargeTokens(ctx, { maxTokens: 0 }, 999_999), 0);
  // null ctx defaults to env, which is 1000; charge under that → fine
  const ctx2 = {};
  assert.equal(chargeTokens(ctx2, null, 999), 999);
});

test("chargeTokens: negative / NaN inputs charge nothing", () => {
  const ctx = {};
  chargeTokens(ctx, {}, -5);
  chargeTokens(ctx, {}, NaN);
  assert.equal(ctx._tokens || 0, 0);
});
