// log — the simplest possible smoke test of the create→update→run→read
// loop. If this passes, the API + queue + worker pipeline is alive.

const { assertServerUp } = require("../helpers/client");
const {
  singleNodeGraph, createGraph, updateGraph, deleteGraph, runGraph,
  uniqName, nodeOutput,
} = require("../helpers/graph");

describe("log", () => {
  let graphId;

  beforeAll(async () => {
    await assertServerUp();
    const dsl = singleNodeGraph({
      name:   uniqName("log"),
      action: "log",
      inputs: { message: "hello from livetest" },
    });
    const g = await createGraph(dsl);
    graphId = g.id;
    await updateGraph(graphId, dsl);
  });

  afterAll(() => deleteGraph(graphId));

  test("logs a static message and finishes successfully", async () => {
    const exec = await runGraph(graphId, { expectStatus: "success" });
    const out = nodeOutput(exec, "log");
    expect(out.status).toBe("success");
    // The log plugin echoes the resolved message back on its output —
    // verify the literal made it through the expression resolver intact.
    expect(out.output).toMatchObject({ message: "hello from livetest" });
  });
});
