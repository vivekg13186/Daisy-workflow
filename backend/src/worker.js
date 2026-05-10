import { Worker } from "bullmq";
import { EventEmitter } from "node:events";
import { config } from "./config.js";
import { QUEUE_NAME, redisConnection } from "./queue/queue.js";
import { pool } from "./db/pool.js";
import { parseDag } from "./dsl/parser.js";
import { executeDag } from "./engine/executor.js";
import { executeBatch } from "./engine/batch.js";
import { loadBuiltins } from "./plugins/registry.js";
import { publish } from "./ws/broadcast.js";
import { log } from "./utils/logger.js";
import { logNodeEvent } from "./utils/eventLog.js";
import { loadTriggerBuiltins } from "./triggers/registry.js";
import { startTriggerManager, stopTriggerManager } from "./triggers/manager.js";
import { loadConfigsMap, buildConfigEnv } from "./configs/loader.js";
import {
  upsertNodeState,
  loadNodeStates,
  reapOrphanedExecutions,
} from "./engine/nodeStateStore.js";

await loadBuiltins();
await loadTriggerBuiltins();
// Subscribe to all enabled triggers on worker boot. Errors per-trigger are
// logged but don't crash the worker.
startTriggerManager().catch(e => log.error("trigger manager start failed", { error: e.message }));

// Reap any execution rows left in `running` from a previous crash. We
// don't know what BullMQ has in flight at this exact moment, but a fresh
// worker process has yet to claim anything — so any RUNNING row is by
// definition stale until it's re-delivered to us as a job.
reapOrphanedExecutions().catch(e => log.warn("orphan reap failed", { error: e.message }));

async function processExecution(job) {
  const { executionId, graphId } = job.data;

  // Resume detection: a job that arrives with status='queued' but already
  // has node_states rows is a user-initiated resume (POST .../resume or
  // .../skip on the executions API). We want to skip the success rows and
  // re-run only what's pending; nothing else needs to know whether we're
  // on a fresh run or a resume.
  const initialNodeStates = await loadNodeStates(executionId);
  const isResume = Object.keys(initialNodeStates).length > 0;
  const inputsOverride = job.data.inputsOverride || {};

  log.info(isResume ? "execution resume" : "execution start", {
    executionId, graphId, resumedNodes: Object.keys(initialNodeStates).length,
  });

  await pool.query(
    "UPDATE executions SET status='running', started_at=COALESCE(started_at, NOW()) WHERE id=$1",
    [executionId],
  );

  const { rows } = await pool.query("SELECT dsl, parsed FROM graphs WHERE id=$1", [graphId]);
  if (rows.length === 0) throw new Error("graph not found");

  // Prefer the parsed-JSONB cache; fall back to re-parsing the dsl text.
  const parsed = rows[0].parsed || parseDag(rows[0].dsl);

  // Pull the user-supplied JSON input that was stashed when the execution row
  // was created. It overlays parsed.data and is exposed as ${data.*} / ${input.*}.
  // (Older rows may only have it in `context`; fall back if `inputs` is empty.)
  const { rows: ctxRows } = await pool.query(
    "SELECT inputs, context FROM executions WHERE id=$1", [executionId],
  );
  const inputsRow = ctxRows[0]?.inputs;
  const userContext =
    (inputsRow && (Array.isArray(inputsRow) || Object.keys(inputsRow).length > 0))
      ? inputsRow
      : (ctxRows[0]?.context || {});

  // Batch mode: if the user-supplied input is { items: [...] } OR a bare array,
  // run the whole DAG once per item. Otherwise treat it as a single-run object.
  const batchItems = Array.isArray(userContext) ? userContext
                   : Array.isArray(userContext?.items) ? userContext.items
                   : null;
  const isBatch = Array.isArray(batchItems);
  // Flat shape: user keys end up directly on ctx (e.g. ${ids}, ${url}).
  const initialData = isBatch ? {} : (userContext && typeof userContext === "object" ? userContext : {});

  // Centralised configurations — exposed two ways to suit different consumers:
  //   • ctx.config.<name>.<key>      → for ${config.<name>.<key>} expressions
  //                                     in plugin inputs / executeIf / batchOver
  //   • ctx.env.CONFIG_<NAME>_<KEY>  → for script-style plugins that expect
  //                                     env-var-flavoured access
  // Failure to load configs (DB down, missing table) leaves both as empty
  // objects so the rest of the run can still proceed.
  const configsMap = await loadConfigsMap().catch((e) => {
    log.warn("configs load failed; continuing with empty config", { error: e.message });
    return {};
  });
  initialData.config = configsMap;
  initialData.env    = { ...buildConfigEnv(configsMap) };

  // Wire engine events into the WebSocket broadcaster + the JSONL event log.
  // Per-node history is no longer persisted to Postgres — the post-execution
  // summary lives in executions.context.nodes (written below).
  const emitter = new EventEmitter();
  emitter.on("node:status", (evt) => {
    publish({ type: "node:status", executionId, ...evt }).catch(() => {});
    logNodeEvent({ type: "node:status", executionId, graphId, ...evt });
  });
  emitter.on("execution:start", (evt) => {
    publish({ type: "execution:start", ...evt }).catch(() => {});
    logNodeEvent({ type: "execution:start", executionId, graphId, ...evt });
  });
  emitter.on("execution:end", (evt) => {
    publish({ type: "execution:end", ...evt }).catch(() => {});
    logNodeEvent({ type: "execution:end", executionId, graphId, ...evt });
  });

  let result;
  try {
    if (isBatch) {
      // Batch mode doesn't yet support per-item resume; the outer
      // executor's persistence still fires for non-batch nodes inside
      // the batch DAG, just not per-item.
      result = await executeBatch(parsed, {
        executionId, emitter, items: batchItems,
        concurrency: 4,
        persistNodeState: upsertNodeState,
      });
    } else {
      result = await executeDag(parsed, {
        executionId, emitter, initialData,
        // Step-1 of the durable-execution design: write state per node.
        persistNodeState:  upsertNodeState,
        // Resume hooks — both no-ops on a fresh run.
        initialNodeStates,
        inputsOverride,
      });
    }
  } catch (e) {
    await pool.query(
      "UPDATE executions SET status='failed', finished_at=NOW(), error=$2 WHERE id=$1",
      [executionId, e.message],
    );
    throw e;
  }

  // Configs are encrypted in `configs.data` at rest, but the engine
  // injects DECRYPTED values into ctx.config / ctx.env so plugins can
  // use them. Those branches must NOT make it into executions.context —
  // anyone with read access to the executions table (or the
  // InstanceViewer) would otherwise see plaintext SMTP / DB / API
  // passwords. Strip them before persisting.
  function redact(ctx) {
    if (!ctx || typeof ctx !== "object") return ctx;
    const { config, env, ...rest } = ctx;
    return rest;
  }

  // For batch runs, persist the per-item summary instead of a single ctx.
  const finalContext = isBatch
    ? { batch: true, items: (result.items || []).map(it => ({
        ...it,
        ctx:    redact(it.ctx),
        // Some batch implementations bubble up the per-item input under
        // `input` — that's user-supplied data, leave it alone.
      })) }
    : redact(result.ctx);
  await pool.query(
    "UPDATE executions SET status=$2, finished_at=NOW(), context=$3 WHERE id=$1",
    [executionId, result.status, JSON.stringify(finalContext)],
  );
  log.info("execution end", { executionId, status: result.status });
  return { status: result.status };
}

const worker = new Worker(QUEUE_NAME, processExecution, {
  connection: redisConnection,
  concurrency: config.workerConcurrency,
});

worker.on("failed", (job, err) => {
  log.error("job failed", { id: job?.id, error: err.message });
});

worker.on("ready", () => log.info("worker ready", { concurrency: config.workerConcurrency }));

process.on("SIGTERM", async () => {
  await stopTriggerManager();
  await worker.close();
  process.exit(0);
});
