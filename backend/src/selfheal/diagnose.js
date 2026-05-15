// Self-heal Tier 2 — LLM-driven diagnosis of a failed execution.
//
// PR A scope: produce a structured analysis on demand. No automation.
// A human still decides whether to act on the recommendation.
//
//   const { diagnosis } = await diagnoseExecution(executionId, { actor, force });
//
// Pipeline:
//   1. Load the execution + per-node states + recent history at the
//      failed node (last 5 runs of the same node on the same graph).
//      Recent audit-log entries on the workflow are folded in too —
//      "the workflow was edited 20 minutes before it started failing"
//      is high-signal context.
//   2. Render a tight, privacy-aware prompt.
//   3. Call the system AI provider (same path /ai/chat uses).
//   4. Parse the JSON response, validate the shape, clamp out-of-
//      range values.
//   5. Persist to execution_diagnoses.
//
// Privacy posture: we send error messages, node names, action types,
// and counts. We never send `resolved_inputs`, `output`, `data`, or
// any config / env values — those frequently contain PII or secrets.
//
// Cost ceiling: ~1k input + ~300 output tokens per call.

import crypto from "node:crypto";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { callProvider } from "../plugins/agent/util.js";
import { log } from "../utils/logger.js";

// ────────────────────────────────────────────────────────────────────
// Public entry point
// ────────────────────────────────────────────────────────────────────

/**
 * Run (or return cached) diagnosis for an execution.
 *
 *   diagnoseExecution(executionId, {
 *     actor: req.user,                 // for created_by + audit
 *     force: false,                    // true → regenerate even if cached
 *   })
 *
 * Returns { cached: bool, diagnosis: row }.
 * Throws if the execution doesn't exist, isn't failed, or the AI
 * provider isn't configured.
 */
export async function diagnoseExecution(executionId, { actor, force = false } = {}) {
  const exec = await loadExecution(executionId);
  if (!exec) throw new Error(`execution ${executionId} not found`);
  if (exec.status !== "failed") {
    throw new Error(`execution ${executionId} is ${exec.status}; diagnose only runs on failed executions`);
  }

  // Return cached diagnosis unless caller forced regenerate.
  if (!force) {
    const cached = await loadCached(executionId);
    if (cached) return { cached: true, diagnosis: cached };
  }

  if (!config.ai.apiKey) {
    throw new Error(
      "AI provider not configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY in the backend env.",
    );
  }

  const context = await gatherContext(exec);
  const prompt  = renderPrompt(context);

  let parsed, usage;
  try {
    const cfg = {
      provider: config.ai.provider,
      apiKey:   config.ai.apiKey,
      model:    config.ai.model,
      baseUrl:  config.ai.baseUrl,
    };
    const r = await callProvider({
      cfg,
      system:   SYSTEM_PROMPT,
      userText: prompt,
      maxTokens: 800,
    });
    usage = r.usage || {};
    parsed = parseDiagnosis(r.text);
  } catch (e) {
    // Persist the failure so the UI can show "tried to diagnose,
    // here's why it didn't work" rather than spinning forever on
    // retries.
    await persistFailure(executionId, exec.workspace_id, actor, e.message);
    throw e;
  }

  await persist(executionId, exec.workspace_id, actor, parsed, {
    model:        config.ai.model,
    inputTokens:  Number(usage.inputTokens)  || 0,
    outputTokens: Number(usage.outputTokens) || 0,
  });

  return { cached: false, diagnosis: await loadCached(executionId) };
}

// ────────────────────────────────────────────────────────────────────
// Cached / load
// ────────────────────────────────────────────────────────────────────

async function loadCached(executionId) {
  const { rows } = await pool.query(
    `SELECT execution_id, workspace_id, confidence, category, root_cause,
            recommended_actions, evidence, model, input_tokens, output_tokens,
            status, error, created_at
       FROM execution_diagnoses
      WHERE execution_id = $1`,
    [executionId],
  );
  return rows[0] || null;
}

async function loadExecution(executionId) {
  const { rows } = await pool.query(
    `SELECT id, graph_id, workspace_id, status, error, created_at, started_at, finished_at
       FROM executions WHERE id = $1`,
    [executionId],
  );
  return rows[0] || null;
}

// ────────────────────────────────────────────────────────────────────
// Context gathering
// ────────────────────────────────────────────────────────────────────

async function gatherContext(exec) {
  // 1. Graph name + the failed node's action type.
  const { rows: graphRows } = await pool.query(
    "SELECT name, parsed FROM graphs WHERE id = $1",
    [exec.graph_id],
  );
  const graph = graphRows[0] || {};
  const dsl   = graph?.parsed || {};
  const nodesByName = new Map((dsl.nodes || []).map(n => [n.name, n]));

  // 2. The failed node(s) from node_states.
  const { rows: failedNodes } = await pool.query(
    `SELECT node_name, attempts, error, started_at, finished_at
       FROM node_states
      WHERE execution_id = $1 AND status = 'failed'
      ORDER BY finished_at NULLS LAST
      LIMIT 5`,
    [exec.id],
  );

  // For each failed node, fetch recent attempts at the SAME node name
  // on the same graph — answers "is this a new failure or a pattern?".
  const failed = [];
  for (const fn of failedNodes) {
    const action = nodesByName.get(fn.node_name)?.action || "unknown";
    const { rows: history } = await pool.query(
      `SELECT ns.status, ns.attempts, ns.error, ns.finished_at
         FROM node_states ns
         JOIN executions e ON e.id = ns.execution_id
        WHERE e.graph_id = $1
          AND ns.node_name = $2
          AND ns.execution_id <> $3
        ORDER BY ns.finished_at DESC NULLS LAST
        LIMIT 5`,
      [exec.graph_id, fn.node_name, exec.id],
    );
    failed.push({
      name:    fn.node_name,
      action,
      attempts: fn.attempts,
      // Bound the error string so a 50KB stack trace doesn't blow the
      // prompt budget.
      error:   truncate(fn.error || "(no error message)", 1200),
      history: history.map(h => ({
        status: h.status,
        attempts: h.attempts,
        error:  h.error ? truncate(h.error, 200) : null,
        when:   h.finished_at,
      })),
    });
  }

  // 3. Recent audit entries on this workflow — useful for "this was
  // edited just before it broke" framing.
  const { rows: recentAudit } = await pool.query(
    `SELECT action, actor_email, created_at
       FROM audit_logs
      WHERE resource_type = 'graph'
        AND resource_id   = $1
        AND created_at > NOW() - INTERVAL '7 days'
      ORDER BY created_at DESC
      LIMIT 5`,
    [exec.graph_id],
  );

  return {
    workflowName: graph.name || "(unknown workflow)",
    execStatus:   exec.status,
    execError:    truncate(exec.error || "(no top-level error)", 600),
    durationSec:
      (exec.started_at && exec.finished_at)
        ? Math.round((new Date(exec.finished_at) - new Date(exec.started_at)) / 1000)
        : null,
    failed,
    recentAudit: recentAudit.map(a => ({
      action: a.action, by: a.actor_email, when: a.created_at,
    })),
  };
}

// ────────────────────────────────────────────────────────────────────
// Prompt
// ────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a workflow-failure diagnostician for the Daisy-workflow engine.

Given the context for a failed execution, return a STRICT JSON object with this shape:

{
  "confidence":         <number 0.0 - 1.0>,
  "category":           "transient" | "config" | "code" | "external" | "unknown",
  "rootCause":          "<one or two short sentences in plain English>",
  "recommendedActions": [
    {
      "action":     "retry" | "retry-with-timeout" | "skip" | "retry-with-inputs" | "escalate",
      "confidence": <number 0.0 - 1.0>,
      "rationale":  "<one short sentence>",
      "params":     { /* action-specific; omit if not relevant */ }
    }
  ],
  "evidence": {
    /* any short structured snippets you used to reach the conclusion */
  }
}

Rules:
- Output ONLY the JSON, no markdown, no preamble, no trailing text.
- Categorise sources: transient=blip likely to clear on retry; config=user/operator setting wrong; code=bug in the plugin or workflow logic; external=upstream service problem; unknown=insufficient evidence.
- Be conservative with high-confidence "auto-fix" recommendations. Prefer "escalate" when the situation is ambiguous.
- The "retry-with-inputs" action requires you to suggest a specific input change in params; only use it when the error makes the fix obvious.`;

function renderPrompt(ctx) {
  const lines = [];
  lines.push(`Workflow: ${ctx.workflowName}`);
  lines.push(`Status: ${ctx.execStatus}`);
  if (ctx.durationSec != null) lines.push(`Duration: ${ctx.durationSec}s`);
  lines.push(`Top-level error: ${ctx.execError}`);
  lines.push("");

  if (!ctx.failed.length) {
    lines.push("No per-node failure records — the run failed before any node ran or after they all succeeded. Diagnose from the top-level error alone.");
  } else {
    lines.push("Failed nodes (in failure order):");
    for (const f of ctx.failed) {
      lines.push(`- ${f.name}  (action: ${f.action}, attempts: ${f.attempts})`);
      lines.push(`  error: ${f.error}`);
      if (f.history.length) {
        lines.push(`  recent history at this node (most-recent first):`);
        for (const h of f.history) {
          lines.push(
            `    • ${h.status}${h.error ? ` — ${h.error}` : ""}${h.when ? ` (${h.when})` : ""}`,
          );
        }
      } else {
        lines.push(`  (no prior runs of this node on this workflow)`);
      }
    }
  }
  lines.push("");

  if (ctx.recentAudit.length) {
    lines.push("Recent edits to this workflow:");
    for (const a of ctx.recentAudit) {
      lines.push(`- ${a.action} by ${a.by || "(unknown)"} at ${a.when}`);
    }
  } else {
    lines.push("No recent edits to this workflow.");
  }
  lines.push("");
  lines.push("Diagnose the failure. Output strict JSON per the system instructions.");
  return lines.join("\n");
}

// ────────────────────────────────────────────────────────────────────
// Response parsing
// ────────────────────────────────────────────────────────────────────

const VALID_CATEGORIES = new Set(["transient", "config", "code", "external", "unknown"]);
const VALID_ACTIONS    = new Set(["retry", "retry-with-timeout", "skip", "retry-with-inputs", "escalate"]);

function parseDiagnosis(rawText) {
  if (!rawText || typeof rawText !== "string") {
    throw new Error("AI provider returned empty response");
  }
  // Strip markdown fences if the model relapsed and emitted ```json
  // around the payload despite instructions.
  let s = rawText.trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```(?:json)?/i, "").replace(/```\s*$/, "").trim();
  }
  let obj;
  try { obj = JSON.parse(s); }
  catch (e) { throw new Error(`AI provider returned non-JSON: ${e.message}`); }

  const conf = clamp01(obj.confidence);
  const cat  = VALID_CATEGORIES.has(obj.category) ? obj.category : "unknown";
  const root = String(obj.rootCause || "").slice(0, 1000);
  const actions = Array.isArray(obj.recommendedActions) ? obj.recommendedActions : [];
  const cleanedActions = actions
    .filter(a => a && VALID_ACTIONS.has(a.action))
    .map(a => ({
      action:     a.action,
      confidence: clamp01(a.confidence),
      rationale:  String(a.rationale || "").slice(0, 500),
      params:     (a.params && typeof a.params === "object") ? a.params : undefined,
    }));
  const evidence = (obj.evidence && typeof obj.evidence === "object") ? obj.evidence : {};

  return {
    confidence:         conf,
    category:           cat,
    rootCause:          root,
    recommendedActions: cleanedActions,
    evidence,
  };
}

function clamp01(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  return Math.max(0, Math.min(1, x));
}

function truncate(s, max) {
  if (s == null) return "";
  const str = String(s);
  return str.length > max ? str.slice(0, max) + "…(truncated)" : str;
}

// ────────────────────────────────────────────────────────────────────
// Persistence
// ────────────────────────────────────────────────────────────────────

async function persist(executionId, workspaceId, actor, parsed, meta) {
  await pool.query(
    `INSERT INTO execution_diagnoses (
       execution_id, workspace_id,
       confidence, category, root_cause, recommended_actions, evidence,
       model, input_tokens, output_tokens,
       status, error, created_by, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'completed',NULL,$11,NOW())
     ON CONFLICT (execution_id) DO UPDATE
        SET workspace_id        = EXCLUDED.workspace_id,
            confidence          = EXCLUDED.confidence,
            category            = EXCLUDED.category,
            root_cause          = EXCLUDED.root_cause,
            recommended_actions = EXCLUDED.recommended_actions,
            evidence            = EXCLUDED.evidence,
            model               = EXCLUDED.model,
            input_tokens        = EXCLUDED.input_tokens,
            output_tokens       = EXCLUDED.output_tokens,
            status              = 'completed',
            error               = NULL,
            created_by          = EXCLUDED.created_by,
            created_at          = NOW()`,
    [
      executionId, workspaceId,
      parsed.confidence, parsed.category, parsed.rootCause,
      JSON.stringify(parsed.recommendedActions),
      JSON.stringify(parsed.evidence),
      meta.model, meta.inputTokens, meta.outputTokens,
      actor?.id || null,
    ],
  );
}

async function persistFailure(executionId, workspaceId, actor, errorMsg) {
  await pool.query(
    `INSERT INTO execution_diagnoses (
       execution_id, workspace_id, status, error, created_by, created_at
     ) VALUES ($1,$2,'failed',$3,$4,NOW())
     ON CONFLICT (execution_id) DO UPDATE
        SET status     = 'failed',
            error      = EXCLUDED.error,
            created_by = EXCLUDED.created_by,
            created_at = NOW()`,
    [executionId, workspaceId, truncate(errorMsg, 1000), actor?.id || null],
  );
}

// ────────────────────────────────────────────────────────────────────
// Test-friendly exports — internal helpers also exposed under a
// namespaced key so test files can exercise the prompt + parser
// without spinning up the AI provider.
// ────────────────────────────────────────────────────────────────────

export const __internal = { renderPrompt, parseDiagnosis, SYSTEM_PROMPT };
