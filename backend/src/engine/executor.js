import { EventEmitter } from "node:events";
import { buildDag } from "./scheduler.js";
import { resolve, evalCondition } from "../dsl/expression.js";
import { registry } from "../plugins/registry.js";

/** Node statuses surfaced through events + persistence. */
export const NodeStatus = Object.freeze({
  PENDING:  "pending",
  RUNNING:  "running",
  RETRYING: "retrying",
  SUCCESS:  "success",
  FAILED:   "failed",
  SKIPPED:  "skipped",
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Execute a parsed DAG.
 *
 * @param {object} parsed   Parsed DSL (already validated).
 * @param {object} opts
 *   - executionId  string (for event payloads)
 *   - initialData  object merged into ctx.data
 *   - emitter      optional EventEmitter; if omitted, a fresh one is created
 * @returns Promise<{status, ctx, nodes}>
 */
export async function executeDag(parsed, opts = {}) {
  const emitter = opts.emitter || new EventEmitter();
  const executionId = opts.executionId || null;

  const { adj, indegree, byName, roots } = buildDag(parsed);
  const remaining = new Map(indegree);                 // mutable copy

  // Slim context:
  //   - parsed.data fields and user input are merged flat at the root, so
  //     expressions like ${url} resolve directly.
  //   - Each node's outputs:[{pluginField: ctxVar}] writes ctxVar at the root
  //     (e.g. ${weatherResult}).
  //   - The full per-node record (status / output / timings / attempts) lives
  //     under nodes.<name> for introspection (${nodes.fetch.output.body.id}).
  const ctx = {
    ...(parsed.data || {}),
    ...(opts.initialData || {}),
    nodes: {},
  };
  const nodeResults = {};                             // status per node
  let aborted = false;
  let aborting = null;                                // { reason }

  function emit(event, payload) {
    emitter.emit(event, { executionId, ...payload, at: new Date().toISOString() });
  }

  // Single source of truth for "this node finished with status X" — keeps
  // nodeResults (engine-internal) and ctx.nodes (persisted to executions.context
  // and read by the UI) in lockstep. Without this, several failure paths used
  // to update nodeResults only, leaving ctx.nodes missing entries — which made
  // the GraphView render the affected nodes as "pending" forever.
  function recordOutcome(name, record) {
    nodeResults[name] = record;
    ctx.nodes[name] = {
      status: record.status,
      output: record.output ?? null,
      error: record.error ?? null,
      reason: record.reason ?? null,
      startedAt: record.startedAt ?? null,
      finishedAt: record.finishedAt ?? null,
      attempts: record.attempts ?? null,
    };
  }

  // Mark every still-unrun node as skipped (used on terminate).
  function skipRest(reason) {
    for (const name of byName.keys()) {
      if (!nodeResults[name]) {
        recordOutcome(name, { status: NodeStatus.SKIPPED, reason });
        emit("node:status", { node: name, status: NodeStatus.SKIPPED, reason });
      }
    }
  }

  async function runOne(node) {
    // 1. Resolve `executeIf`.
    if (node.executeIf) {
      let cond = false;
      try { cond = evalCondition(node.executeIf, ctx); }
      catch (e) {
        recordOutcome(node.name, { status: NodeStatus.FAILED, error: `executeIf eval failed: ${e.message}` });
        emit("node:status", { node: node.name, status: NodeStatus.FAILED, error: e.message });
        return;
      }
      if (!cond) {
        recordOutcome(node.name, { status: NodeStatus.SKIPPED, reason: "executeIf=false" });
        emit("node:status", { node: node.name, status: NodeStatus.SKIPPED, reason: "executeIf=false" });
        return;
      }
    }

    // 2. Resolve inputs once (for non-batch).
    const rawInputs = node.inputs || {};
    let resolvedInputs;
    try { resolvedInputs = resolve(rawInputs, ctx); }
    catch (e) {
      recordOutcome(node.name, { status: NodeStatus.FAILED, error: `input resolve failed: ${e.message}` });
      emit("node:status", { node: node.name, status: NodeStatus.FAILED, error: e.message });
      return handleFailure(node, e);
    }

    // 3. Batch handling — fan out over an array.
    let batchItems = null;
    if (node.batchOver) {
      try { batchItems = resolve(node.batchOver, ctx); }
      catch (e) {
        recordOutcome(node.name, { status: NodeStatus.FAILED, error: `batchOver eval failed: ${e.message}` });
        emit("node:status", { node: node.name, status: NodeStatus.FAILED, error: e.message });
        return handleFailure(node, e);
      }
      if (!Array.isArray(batchItems)) {
        const err = new Error(`batchOver did not resolve to an array (got ${typeof batchItems})`);
        recordOutcome(node.name, { status: NodeStatus.FAILED, error: err.message });
        emit("node:status", { node: node.name, status: NodeStatus.FAILED, error: err.message });
        return handleFailure(node, err);
      }
    }

    const startedAt = new Date().toISOString();
    emit("node:status", { node: node.name, status: NodeStatus.RUNNING, input: resolvedInputs });

    const attemptOnce = async (input) => {
      const maxRetries = node.retry || 0;
      const delayMs = parseDuration(node.retryDelay) || 0;
      let attempt = 0;
      let lastErr;
      while (attempt <= maxRetries) {
        attempt++;
        try {
          const out = await registry.invoke(node.action, input, ctx);
          return { ok: true, output: out, attempts: attempt };
        } catch (e) {
          lastErr = e;
          emit("node:status", {
            node: node.name, status: NodeStatus.RETRYING, attempt, error: e.message,
          });
          if (attempt > maxRetries) break;
          if (delayMs) await sleep(delayMs);
        }
      }
      return { ok: false, error: lastErr, attempts: attempt };
    };

    let output, attempts;
    try {
      if (batchItems) {
        const results = await Promise.all(
          batchItems.map(async (item, i) => {
            const itemCtx = { ...ctx, item, index: i };
            const itemInputs = resolve(rawInputs, itemCtx);
            const r = await attemptOnce(itemInputs);
            if (!r.ok) throw r.error;
            return r.output;
          }),
        );
        output = { items: results, count: results.length };
        attempts = 1;
      } else {
        const r = await attemptOnce(resolvedInputs);
        if (!r.ok) throw r.error;
        output = r.output;
        attempts = r.attempts;
      }
    } catch (e) {
      recordOutcome(node.name, {
        status: NodeStatus.FAILED, error: e.message,
        startedAt, finishedAt: new Date().toISOString(),
      });
      emit("node:status", { node: node.name, status: NodeStatus.FAILED, error: e.message });
      return handleFailure(node, e);
    }

    // 4. Surface the node's outputs into ctx.
    //   - Each `outputs: { pluginField: ctxVar }` mapping writes the named
    //     subfield to the ROOT of ctx (so downstream nodes do `${ctxVar}`).
    //   - Full raw plugin output is also kept on ctx.nodes[name].output via
    //     recordOutcome below.
    const finishedAt = new Date().toISOString();
    applyOutputMapping(output, node.outputs, ctx);
    recordOutcome(node.name, {
      status: NodeStatus.SUCCESS, output, attempts, startedAt, finishedAt,
    });
    const nodeOutput = output;
    emit("node:status", {
      node: node.name, status: NodeStatus.SUCCESS, output: nodeOutput, attempts, startedAt, finishedAt,
    });
  }

  function handleFailure(node) {
    if ((node.onError || "terminate") === "terminate") {
      aborted = true;
      aborting = { reason: `node ${node.name} failed` };
    }
  }

  // Layer-by-layer scheduler.
  emit("execution:start", { graph: parsed.name });
  const ready = [...roots];
  while (ready.length && !aborted) {
    const layer = ready.splice(0, ready.length);
    await Promise.all(layer.map(name => runOne(byName.get(name))));
    if (aborted) break;
    for (const name of layer) {
      for (const next of adj.get(name)) {
        const r = remaining.get(next) - 1;
        remaining.set(next, r);
        if (r === 0) ready.push(next);
      }
    }
  }

  if (aborted) skipRest(aborting?.reason || "aborted");

  // Final reconciliation: any declared node that didn't get an outcome (e.g.
  // engine bug, unexpected throw) is recorded as skipped so the persisted
  // ctx.nodes always has a row per declared node — UI never shows "pending".
  for (const name of byName.keys()) {
    if (!nodeResults[name]) {
      recordOutcome(name, { status: NodeStatus.SKIPPED, reason: "not reached" });
    }
  }

  // Aggregate status.
  const statuses = Object.values(nodeResults).map(r => r.status);
  let overall;
  if (aborted) overall = "failed";
  else if (statuses.some(s => s === NodeStatus.FAILED)) overall = "partial";
  else overall = "success";

  emit("execution:end", { status: overall, nodes: nodeResults });
  return { status: overall, ctx, nodes: nodeResults };
}

/**
 * Apply a node's `outputs:` mapping.
 *
 * DSL form:
 *     outputs:
 *       - json: weatherResult        # take pluginOutput.json -> ctx.weatherResult
 *
 * After parsing this becomes  outputs: { json: "weatherResult" }.
 * For each pair (pluginField -> ctxVar), copy raw[pluginField] into ctx[ctxVar].
 * Falls back to dot-paths in the plugin field name (e.g. "body.id").
 */
function applyOutputMapping(raw, mapping, ctx) {
  if (!mapping || Object.keys(mapping).length === 0) return;
  for (const [pluginField, ctxVar] of Object.entries(mapping)) {
    if (!ctxVar) continue;
    ctx[ctxVar] = getPath(raw, pluginField);
  }
}

function getPath(obj, path) {
  if (!path) return obj;
  const parts = String(path).split(".");
  let cur = obj;
  for (const p of parts) { if (cur == null) return undefined; cur = cur[p]; }
  return cur;
}

/** Accept either a number (ms) or a duration string like "500ms", "2s". */
function parseDuration(d) {
  if (d == null) return 0;
  if (typeof d === "number") return d;
  const m = String(d).match(/^(\d+)\s*(ms|s|m)?$/);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  switch (m[2] || "ms") {
    case "ms": return n;
    case "s":  return n * 1000;
    case "m":  return n * 60000;
    default:   return n;
  }
}
