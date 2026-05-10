// Lifecycle helpers for the create-update-execute-cleanup pattern every
// test file uses.
//
// Each test:
//   1. POST /graphs           with an initial DSL → captures graph id
//   2. PUT  /graphs/:id       with the updated DSL (matches the user spec
//                              for "update the graph with json")
//   3. POST /graphs/:id/execute — kicks off a run
//   4. pollExecution(...)     — waits for terminal status
//   5. DELETE /graphs/:id     in afterAll → removes the row
//
// The DSL is always a plain JS object (the API accepts it as a JSON
// string in the `dsl` field).

const { request } = require("./client");
const { pollExecution } = require("./poll");

/**
 * Build a single-node DAG. `name` becomes the graph name (and the only
 * node's name unless `nodeName` is given). Extra plugin inputs are
 * passed through verbatim.
 */
function singleNodeGraph({ name, action, inputs = {}, nodeName, extras = {} }) {
  return {
    name,
    description: `live test for ${action}`,
    nodes: [{
      name: nodeName || action.replace(/[^A-Za-z0-9]/g, "_"),
      action,
      inputs,
      ...extras,
    }],
  };
}

/** POST /graphs with the given DSL object — returns { id, name }. */
async function createGraph(dslObj) {
  const res = await request()
    .post("/graphs")
    .send({ dsl: JSON.stringify(dslObj) })
    .set("content-type", "application/json");
  if (res.status !== 201) {
    throw new Error(`POST /graphs → ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

/** PUT /graphs/:id — DSL.name MUST match the existing row's name. */
async function updateGraph(id, dslObj) {
  const res = await request()
    .put(`/graphs/${id}`)
    .send({ dsl: JSON.stringify(dslObj) })
    .set("content-type", "application/json");
  if (res.status !== 200) {
    throw new Error(`PUT /graphs/${id} → ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

/** Soft-delete the graph. Errors are swallowed so afterAll never masks a real failure. */
async function deleteGraph(id) {
  if (!id) return;
  try { await request().delete(`/graphs/${id}`); } catch { /* ignore */ }
}

/**
 * POST /graphs/:id/execute then poll to terminal. Returns the final
 * execution row (`{ id, status, context, ... }`). When `expectStatus`
 * is provided, throws unless the execution ended in that state — handy
 * for tests that want to assert "this should have failed with X".
 */
async function runGraph(id, { context = {}, expectStatus, timeoutMs } = {}) {
  const enq = await request()
    .post(`/graphs/${id}/execute`)
    .send({ context })
    .set("content-type", "application/json");
  if (enq.status !== 202) {
    throw new Error(`POST /graphs/${id}/execute → ${enq.status}: ${JSON.stringify(enq.body)}`);
  }
  const final = await pollExecution(enq.body.executionId, { timeoutMs });
  if (expectStatus && final.status !== expectStatus) {
    throw new Error(
      `Expected execution ${enq.body.executionId} to finish '${expectStatus}', ` +
      `got '${final.status}'. error: ${final.error || "(none)"}, ` +
      `context: ${JSON.stringify(final.context)}`,
    );
  }
  return final;
}

/**
 * Convenience: run a one-off graph (create → update → execute → delete)
 * in a single call. Used by the SQL test fixtures for setup/teardown
 * (CREATE TABLE / DROP TABLE) where the test doesn't need to keep the
 * graph around afterwards.
 */
async function oneShot(dslObj, runOpts = {}) {
  const created = await createGraph(dslObj);
  await updateGraph(created.id, dslObj);
  try {
    return await runGraph(created.id, runOpts);
  } finally {
    await deleteGraph(created.id);
  }
}

/** Generate a unique graph name so concurrent runs don't collide on the unique-name index. */
function uniqName(label) {
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  return `livetest-${label}-${stamp}`;
}

/** Pull a node's recorded entry out of the redacted ctx. */
function nodeOutput(execRow, nodeName) {
  const node = execRow?.context?.nodes?.[nodeName];
  if (!node) {
    throw new Error(
      `Execution ${execRow?.id} has no ctx.nodes['${nodeName}']. ` +
      `Recorded nodes: ${Object.keys(execRow?.context?.nodes || {}).join(", ") || "(none)"}`,
    );
  }
  return node;
}

module.exports = {
  singleNodeGraph,
  createGraph,
  updateGraph,
  deleteGraph,
  runGraph,
  oneShot,
  uniqName,
  nodeOutput,
};
