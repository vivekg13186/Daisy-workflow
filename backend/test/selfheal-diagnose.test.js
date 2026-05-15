// Unit tests for the diagnosis prompt + parser.
//
// We don't call out to the AI provider here — that path is exercised
// by /ai/chat tests. What's specific to self-heal Tier 2 is:
//
//   1. The prompt assembly serialises the gathered context into a
//      compact, deterministic string. Regressions in shape would
//      degrade the LLM's outputs silently; nail them down.
//   2. The parser must tolerate the LLM's actual quirks: markdown
//      fences around JSON, out-of-range confidences, unknown action
//      names. Out-of-band values get clamped or stripped.

import { test } from "node:test";
import assert from "node:assert/strict";

// `JWT_SECRET` is touched by transitively-imported modules; set
// something to keep their initialisers happy.
process.env.JWT_SECRET            = process.env.JWT_SECRET            || "test";
process.env.RATE_LIMIT_ENABLED    = process.env.RATE_LIMIT_ENABLED    || "false";

const { __internal } = await import("../src/selfheal/diagnose.js");
const { renderPrompt, parseDiagnosis, SYSTEM_PROMPT } = __internal;

// ────────────────────────────────────────────────────────────────────
// Prompt assembly
// ────────────────────────────────────────────────────────────────────

test("renderPrompt: includes workflow + error + failed nodes", () => {
  const out = renderPrompt({
    workflowName: "weekly-report",
    execStatus:   "failed",
    execError:    "node fetch_url threw: ECONNREFUSED",
    durationSec:  37,
    failed: [{
      name: "fetch_url",
      action: "http.request",
      attempts: 3,
      error:   "ECONNREFUSED 10.0.0.7:443",
      history: [
        { status: "success", attempts: 1, error: null, when: "2026-05-09T..." },
        { status: "failed",  attempts: 3, error: "timeout", when: "2026-05-10T..." },
      ],
    }],
    recentAudit: [
      { action: "graph.update", by: "vivek@x.com", when: "2026-05-10T..." },
    ],
  });
  assert.match(out, /Workflow: weekly-report/);
  assert.match(out, /Status: failed/);
  assert.match(out, /Duration: 37s/);
  assert.match(out, /ECONNREFUSED/);
  assert.match(out, /fetch_url/);
  assert.match(out, /http\.request/);
  assert.match(out, /attempts: 3/);
  // History bullets present — one success, one failed.
  assert.match(out, /• success/);
  assert.match(out, /• failed — timeout/);
  // Audit folded in.
  assert.match(out, /Recent edits/);
  assert.match(out, /graph\.update.*vivek@x\.com/);
});

test("renderPrompt: handles 'no failed-node states' edge case", () => {
  const out = renderPrompt({
    workflowName: "wf",
    execStatus:   "failed",
    execError:    "engine crashed",
    durationSec:  null,
    failed: [],
    recentAudit: [],
  });
  assert.match(out, /No per-node failure records/);
  assert.match(out, /No recent edits/);
});

test("system prompt names the engine + locks the response shape", () => {
  assert.match(SYSTEM_PROMPT, /Daisy-workflow/);
  assert.match(SYSTEM_PROMPT, /transient/);
  assert.match(SYSTEM_PROMPT, /config/);
  assert.match(SYSTEM_PROMPT, /code/);
  assert.match(SYSTEM_PROMPT, /external/);
  assert.match(SYSTEM_PROMPT, /Output ONLY the JSON/);
});

// ────────────────────────────────────────────────────────────────────
// Response parsing
// ────────────────────────────────────────────────────────────────────

const PERFECT = JSON.stringify({
  confidence: 0.85,
  category:   "transient",
  rootCause:  "Upstream timed out; 23 successes in the last hour.",
  recommendedActions: [
    { action: "retry", confidence: 0.9, rationale: "transient", params: {} },
  ],
  evidence: { recentSuccessCount: 23 },
});

test("parseDiagnosis: clean response round-trips", () => {
  const d = parseDiagnosis(PERFECT);
  assert.equal(d.confidence, 0.85);
  assert.equal(d.category,   "transient");
  assert.match(d.rootCause,  /upstream timed out/i);
  assert.equal(d.recommendedActions.length, 1);
  assert.equal(d.recommendedActions[0].action, "retry");
  assert.equal(d.evidence.recentSuccessCount, 23);
});

test("parseDiagnosis: strips ```json fences the model sometimes adds", () => {
  const wrapped = "```json\n" + PERFECT + "\n```";
  const d = parseDiagnosis(wrapped);
  assert.equal(d.category, "transient");
});

test("parseDiagnosis: clamps out-of-range confidence", () => {
  const obj = { ...JSON.parse(PERFECT), confidence: 7.5 };
  assert.equal(parseDiagnosis(JSON.stringify(obj)).confidence, 1);
});

test("parseDiagnosis: unknown category becomes 'unknown'", () => {
  const obj = { ...JSON.parse(PERFECT), category: "supernova" };
  assert.equal(parseDiagnosis(JSON.stringify(obj)).category, "unknown");
});

test("parseDiagnosis: drops actions with invalid action names", () => {
  const obj = JSON.parse(PERFECT);
  obj.recommendedActions = [
    { action: "retry",  confidence: 0.9, rationale: "ok" },
    { action: "delete-database", confidence: 1, rationale: "no" },
    { action: "skip",   confidence: 0.4, rationale: "fallback" },
  ];
  const d = parseDiagnosis(JSON.stringify(obj));
  assert.equal(d.recommendedActions.length, 2);
  assert.deepEqual(d.recommendedActions.map(a => a.action), ["retry", "skip"]);
});

test("parseDiagnosis: throws on non-JSON response", () => {
  assert.throws(() => parseDiagnosis("hello, here is your analysis: …"), /non-JSON/);
});

test("parseDiagnosis: long rootCause is truncated", () => {
  const obj = { ...JSON.parse(PERFECT), rootCause: "x".repeat(2000) };
  assert.equal(parseDiagnosis(JSON.stringify(obj)).rootCause.length, 1000);
});
