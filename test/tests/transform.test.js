// transform — FEEL expression evaluation. We round-trip a small list
// comprehension to make sure the FEEL runtime is wired into the engine
// (catches a regression where transform falls back to the literal
// passthrough path).

const { assertServerUp } = require("../helpers/client");
const {
  singleNodeGraph, createGraph, updateGraph, deleteGraph, runGraph,
  uniqName, nodeOutput,
} = require("../helpers/graph");

describe("transform", () => {
  let graphId;

  beforeAll(async () => {
    await assertServerUp();
    const dsl = singleNodeGraph({
      name:   uniqName("transform"),
      action: "transform",
      // FEEL for-expression: each item doubled, returned as an array.
      // Note: no outer brackets — the `for` expression already yields a
      // list. Wrapping it in `[…]` would produce a list-of-lists.
      inputs: { expression: "for n in [1,2,3] return n * 2" },
    });
    const g = await createGraph(dsl);
    graphId = g.id;
    await updateGraph(graphId, dsl);
  });

  afterAll(() => deleteGraph(graphId));

  test("evaluates a FEEL expression and returns it under .value", async () => {
    const exec = await runGraph(graphId, { expectStatus: "success" });
    const out = nodeOutput(exec, "transform");
    expect(out.status).toBe("success");
    expect(out.output).toEqual({ value: [2, 4, 6] });
  });
});
