// delay — verifies the worker actually sleeps, then surfaces the slept
// duration on its output. Kept short (50ms) so the suite stays fast.

const { assertServerUp } = require("../helpers/client");
const {
  singleNodeGraph, createGraph, updateGraph, deleteGraph, runGraph,
  uniqName, nodeOutput,
} = require("../helpers/graph");

describe("delay", () => {
  let graphId;

  beforeAll(async () => {
    await assertServerUp();
    const dsl = singleNodeGraph({
      name:   uniqName("delay"),
      action: "delay",
      inputs: { ms: 50 },
    });
    const g = await createGraph(dsl);
    graphId = g.id;
    await updateGraph(graphId, dsl);
  });

  afterAll(() => deleteGraph(graphId));

  test("sleeps for the requested duration and reports it back", async () => {
    const exec = await runGraph(graphId, { expectStatus: "success" });
    const out = nodeOutput(exec, "delay");
    expect(out.status).toBe("success");
    expect(out.output).toEqual({ slept: 50 });
  });
});
