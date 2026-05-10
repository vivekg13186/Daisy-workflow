// Poll an execution to a terminal status (success / failed) and return
// the final row.
//
// The worker writes status='running' the moment it picks up a job and
// status='success' | 'failed' on completion; it also writes the redacted
// ctx into executions.context (so per-node output is reachable as
// row.context.nodes.<name>.output).
//
// Polling beats blocking on a websocket here because the test suite
// already round-trips through the REST API for everything else; one
// codepath is easier to reason about when something flakes.

const { request } = require("./client");

const TERMINAL = new Set(["success", "failed"]);

async function pollExecution(executionId, { timeoutMs = 15_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    const res = await request().get(`/executions/${executionId}`);
    if (res.status === 404) {
      // The row should exist immediately after enqueue; if it isn't there
      // yet, give the writer a moment.
      await sleep(intervalMs);
      continue;
    }
    if (res.status !== 200) {
      throw new Error(`GET /executions/${executionId} → ${res.status}: ${JSON.stringify(res.body)}`);
    }
    last = res.body;
    if (TERMINAL.has(last.status)) return last;
    await sleep(intervalMs);
  }
  throw new Error(
    `Execution ${executionId} did not reach a terminal status within ${timeoutMs}ms. ` +
    `Last seen: ${last ? last.status : "(no row)"}`,
  );
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { pollExecution, TERMINAL };
