// Execution resource limits — wall-clock timeouts + retry cap.
//
// What this module owns:
//
//   • Layered defaults (env → workflow DSL → per-node DSL).
//   • Duration parsing ("30s", "5m", "200ms", or a bare number = ms).
//   • Error classes the engine throws when a limit fires.
//   • withTimeout(promise, ms, error) — the Promise.race helper that
//     enforces wall-clock budgets without leaking a setTimeout when
//     the underlying promise resolves first.
//
// What this module deliberately doesn't do:
//
//   • Cancel the underlying work. Promise.race rejects the awaiter,
//     but the work continues in the background until it finishes on
//     its own. PR 7's scope is "stop blocking the worker"; cooperative
//     cancellation via AbortSignal is the follow-up PR's job. The
//     leak window is bounded by whatever the plugin's natural timeout
//     is (HTTP defaults, socket idle timers, etc).

// ────────────────────────────────────────────────────────────────────
// Error classes
// ────────────────────────────────────────────────────────────────────

/** Thrown when a single plugin invocation exceeds its wall-clock
 *  budget. Retryable in principle (the upstream might be slow), so
 *  the executor's retry loop will keep trying up to the cap. */
export class NodeTimeoutError extends Error {
  constructor(nodeName, ms) {
    super(`node "${nodeName}" timed out after ${ms}ms`);
    this.name = "NodeTimeoutError";
    this.code = "NODE_TIMEOUT";
    this.nodeName = nodeName;
    this.timeoutMs = ms;
  }
}

/** Thrown when an entire execution exceeds its wall-clock budget.
 *  Terminal — re-running the whole DAG isn't going to succeed any
 *  faster, so the worker fails the execution outright. */
export class WorkflowTimeoutError extends Error {
  constructor(ms) {
    super(`workflow timed out after ${ms}ms`);
    this.name = "WorkflowTimeoutError";
    this.code = "WORKFLOW_TIMEOUT";
    this.timeoutMs = ms;
  }
}

/** Thrown when batch fan-out (executeBatch items, batch nodes) or
 *  workflow.fire spawn chains try to exceed the configured ceiling.
 *  Terminal — the caller is in a runaway loop, retrying won't help. */
export class IterationCapError extends Error {
  constructor(where, count, max) {
    super(`${where}: iteration cap exceeded (${count} > ${max})`);
    this.name = "IterationCapError";
    this.code = "ITERATION_CAP";
    this.where = where;
    this.count = count;
    this.max   = max;
  }
}

/** Thrown when a per-execution token budget is exhausted (agents).
 *  Terminal — runaway LLM loops should fail loud, not silently
 *  burn credits. */
export class BudgetExhaustedError extends Error {
  constructor(used, max, kind = "tokens") {
    super(`${kind} budget exhausted (${used}/${max})`);
    this.name = "BudgetExhaustedError";
    this.code = "BUDGET_EXHAUSTED";
    this.used = used;
    this.max  = max;
    this.kind = kind;
  }
}

// ────────────────────────────────────────────────────────────────────
// Duration parsing
// ────────────────────────────────────────────────────────────────────

/**
 * Parse a duration into milliseconds. Accepts:
 *   • a finite number               → returned as-is (ms)
 *   • "<n>ms" | "<n>s" | "<n>m" | "<n>h"
 *   • a bare digit string           → ms
 *
 * Returns null for empty/invalid input so the caller can fall back to
 * a default rather than silently treating "garbage" as 0ms.
 */
export function parseDurationMs(input) {
  if (input == null || input === "") return null;
  if (typeof input === "number") {
    return Number.isFinite(input) && input >= 0 ? input : null;
  }
  const m = String(input).trim().match(/^(\d+)\s*(ms|s|m|h)?$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  switch (m[2] || "ms") {
    case "ms": return n;
    case "s":  return n * 1000;
    case "m":  return n * 60_000;
    case "h":  return n * 3_600_000;
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────
// Layered defaults
//
// Read once at module load. Tests that need different values poke
// process.env BEFORE importing this module (see test/limits.test.js).
// ────────────────────────────────────────────────────────────────────

const DEFAULTS = Object.freeze({
  nodeTimeoutMs:
    parseDurationMs(process.env.EXECUTION_DEFAULT_NODE_TIMEOUT)     ?? 60_000,        // 60s
  workflowTimeoutMs:
    parseDurationMs(process.env.EXECUTION_DEFAULT_WORKFLOW_TIMEOUT) ?? 30 * 60_000,   // 30m
  maxRetries:
    nonNegativeInt(process.env.EXECUTION_MAX_RETRIES) ?? 10,
  // Hard ceiling on per-execution fan-out — batch items, workflow.fire
  // spawn chains, and any future loop constructs. Default 10k is
  // comfortably above legitimate use cases (the largest practical
  // batch we've seen is ~2k rows).
  maxIterations:
    nonNegativeInt(process.env.EXECUTION_MAX_ITERATIONS) ?? 10_000,
  // Per-execution token budget for agent / LLM calls. Sum of
  // inputTokens + outputTokens across every agent invocation in the
  // run. Default 100k tokens ≈ a few dollars on most providers; pick
  // a tighter cap if cost is a concern. 0 / "" disables the check.
  maxTokens:
    nonNegativeInt(process.env.EXECUTION_MAX_TOKENS) ?? 100_000,
});

export function getDefaults() { return DEFAULTS; }

function nonNegativeInt(s) {
  if (s == null || s === "") return null;
  const n = parseInt(String(s), 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// ────────────────────────────────────────────────────────────────────
// Resolvers — layered (per-node → per-workflow → env default)
// ────────────────────────────────────────────────────────────────────

/**
 * Resolve the wall-clock budget for one plugin invocation.
 *
 *   nodeTimeoutMs(node, parsed)
 *
 * Per-node `timeout` wins. Falls back to the workflow-level `timeout`,
 * then to EXECUTION_DEFAULT_NODE_TIMEOUT. Returns null if every layer
 * is unset and the env default is "" (operator chose to disable).
 */
export function resolveNodeTimeoutMs(node, parsed) {
  const fromNode     = parseDurationMs(node?.timeout);
  const fromWorkflow = parseDurationMs(parsed?.nodeTimeout);
  return fromNode ?? fromWorkflow ?? DEFAULTS.nodeTimeoutMs ?? null;
}

/** Resolve the workflow-level wall-clock budget. Workflow DSL beats
 *  env default. Null = no workflow-level timeout. */
export function resolveWorkflowTimeoutMs(parsed) {
  const fromWorkflow = parseDurationMs(parsed?.timeout);
  return fromWorkflow ?? DEFAULTS.workflowTimeoutMs ?? null;
}

/**
 * Clamp the user-supplied retry count to the configured maximum.
 * Negative or non-numeric values become 0. This is the function the
 * executor uses to interpret `node.retry` so callers never have to
 * remember the cap.
 */
export function resolveMaxRetries(nodeRetry) {
  const n = Number(nodeRetry);
  const requested = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  return Math.min(requested, DEFAULTS.maxRetries);
}

/**
 * Per-workflow `maxIterations` overrides env default. Used by
 * executeBatch + workflow.fire + node-level batch fan-out.
 */
export function resolveMaxIterations(parsed) {
  const fromWorkflow = nonNegativeInt(parsed?.maxIterations);
  return fromWorkflow ?? DEFAULTS.maxIterations;
}

/** Per-execution token budget. Per-workflow `maxTokens` overrides
 *  env default. Returns 0 → unlimited (callers should treat 0 as
 *  "no check"). */
export function resolveMaxTokens(parsed) {
  const fromWorkflow = nonNegativeInt(parsed?.maxTokens);
  return fromWorkflow ?? DEFAULTS.maxTokens;
}

/**
 * Enforce the iteration cap. Throws IterationCapError if `count`
 * exceeds the resolved maximum. Stateless — caller is responsible
 * for knowing what `count` represents (items in a batch, depth of
 * a fire chain, etc).
 */
export function assertIterationCap(parsed, count, where) {
  const max = resolveMaxIterations(parsed);
  if (count > max) throw new IterationCapError(where, count, max);
}

/**
 * Accumulate token usage onto ctx. Throws BudgetExhaustedError if
 * the running total crosses the configured budget. Returns the new
 * total so callers can attach it to telemetry / span attributes.
 *
 * Stored under `ctx._tokens` (underscore-prefixed so it's stripped
 * from persisted execution context by the worker's redact step,
 * same as ctx.config / ctx.env).
 */
export function chargeTokens(ctx, parsed, used) {
  const max = resolveMaxTokens(parsed);
  if (!max) return ctx._tokens || 0;            // unlimited
  const before = ctx._tokens || 0;
  const after  = before + Math.max(0, used | 0);
  ctx._tokens = after;
  if (after > max) throw new BudgetExhaustedError(after, max, "tokens");
  return after;
}

// ────────────────────────────────────────────────────────────────────
// withTimeout helper
//
// Promise.race against a setTimeout, with the timer cleared when the
// inner promise wins so we don't leak handles in long-running tests
// or under high churn. Pass null / Infinity for ms to disable.
// ────────────────────────────────────────────────────────────────────

export function withTimeout(promise, ms, makeError) {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return promise;
  return new Promise((resolve, reject) => {
    let settled = false;
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(typeof makeError === "function" ? makeError() : makeError);
    }, ms);
    // Avoid keeping the event loop alive just because of this timer.
    if (typeof t.unref === "function") t.unref();
    promise.then(
      (v) => { if (!settled) { settled = true; clearTimeout(t); resolve(v); } },
      (e) => { if (!settled) { settled = true; clearTimeout(t); reject(e); } },
    );
  });
}
