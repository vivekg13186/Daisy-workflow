import { executeDag } from "./executor.js";
import { assertIterationCap } from "./limits.js";

/**
 * Run the entire DAG once per item in `items` (in parallel up to `concurrency`).
 * Each item produces an independent execution result; events are tagged with
 * a sub-execution id so the UI can group them.
 *
 * @param {object} parsed       Parsed & normalized DSL
 * @param {object} opts
 *   - items: any[]             One DAG run per element (passed as initialData)
 *   - concurrency: number      Max parallel runs (default 4)
 *   - executionId: string      Parent execution id (for event tagging)
 *   - emitter: EventEmitter    Engine event emitter (events get .item, .index)
 * @returns Promise<{status, items: Array<{index, status, ctx, nodes, error?}>}>
 */
export async function executeBatch(parsed, opts) {
  const items = opts.items || [];
  // Refuse a batch larger than EXECUTION_MAX_ITERATIONS (default 10k).
  // Per-workflow `maxIterations` in the DSL overrides the env default.
  // The cap is enforced UP-FRONT, before any node fires — a 50k-item
  // request fails immediately instead of consuming the first 10k worth
  // of work and then realising it's too big.
  assertIterationCap(parsed, items.length, "executeBatch");
  const concurrency = Math.max(1, opts.concurrency || 4);
  const emitter = opts.emitter;
  const parentExecutionId = opts.executionId;

  // Sub-emitter that tags every event with the item index. This lets the UI
  // and persistence layer attribute events to the correct iteration.
  function makeChildEmitter(index) {
    return {
      emit(event, payload) {
        emitter?.emit(event, { ...payload, batchIndex: index });
      },
      on()  { /* no-op — children only emit upward */ },
      once(){},
    };
  }

  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      const item = items[i];
      const childEmitter = makeChildEmitter(i);
      try {
        const r = await executeDag(parsed, {
          executionId: `${parentExecutionId}#${i}`,
          emitter: childEmitter,
          initialData: typeof item === "object" && item !== null ? item : { input: item },
        });
        results[i] = { index: i, status: r.status, ctx: r.ctx, nodes: r.nodes };
      } catch (e) {
        results[i] = { index: i, status: "failed", error: e.message };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));

  const overall = results.every(r => r.status === "success") ? "success"
                : results.every(r => r.status === "failed")  ? "failed"
                : "partial";
  emitter?.emit("execution:end", {
    executionId: parentExecutionId,
    status: overall,
    batch: { total: items.length, success: results.filter(r => r.status === "success").length },
    at: new Date().toISOString(),
  });
  return { status: overall, items: results };
}
