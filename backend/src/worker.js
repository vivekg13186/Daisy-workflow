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

await loadBuiltins();
await loadTriggerBuiltins();
// Subscribe to all enabled triggers on worker boot. Errors per-trigger are
// logged but don't crash the worker.
startTriggerManager().catch(e => log.error("trigger manager start failed", { error: e.message }));

async function processExecution(job) {
  const { executionId, graphId } = job.data;
  log.info("execution start", { executionId, graphId });

  await pool.query(
    "UPDATE executions SET status='running', started_at=NOW() WHERE id=$1",
    [executionId],
  );

  const { rows } = await pool.query("SELECT yaml, parsed FROM graphs WHERE id=$1", [graphId]);
  if (rows.length === 0) throw new Error("graph not found");

  // Re-validate (in case the YAML was edited between save and run).
  const parsed = rows[0].parsed || parseDag(rows[0].yaml);

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
      result = await executeBatch(parsed, {
        executionId, emitter, items: batchItems,
        concurrency: 4,
      });
    } else {
      result = await executeDag(parsed, { executionId, emitter, initialData });
    }
  } catch (e) {
    await pool.query(
      "UPDATE executions SET status='failed', finished_at=NOW(), error=$2 WHERE id=$1",
      [executionId, e.message],
    );
    throw e;
  }

  // For batch runs, persist the per-item summary instead of a single ctx.
  const finalContext = isBatch
    ? { batch: true, items: result.items }
    : result.ctx;
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
