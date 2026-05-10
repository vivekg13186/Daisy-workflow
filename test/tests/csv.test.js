// csv.* — write a 2D array out, read it back, and assert the round-trip
// is lossless. csv.write here uses the `data` var-input shape (a JSON
// array literal in the node's inputs is fine; the engine resolves it to
// the array before the plugin runs).

const fs = require("fs");
const { assertServerUp } = require("../helpers/client");
const {
  singleNodeGraph, createGraph, updateGraph, deleteGraph, runGraph,
  uniqName, nodeOutput,
} = require("../helpers/graph");
const { tmpPath } = require("../helpers/fixtures");

describe("csv.*", () => {
  const filePath = tmpPath(`livetest-${Date.now()}.csv`);
  const matrix = [
    ["id", "name",   "score"],
    [1,    "alice",  9.5    ],
    [2,    "bob",    8.0    ],
    [3,    "carol", 10.0    ],
  ];
  const graphIds = {};

  beforeAll(async () => {
    await assertServerUp();
    for (const [key, dsl] of Object.entries({
      write: singleNodeGraph({
        name: uniqName("csv-write"), action: "csv.write",
        nodeName: "csvw",
        inputs: { path: filePath, data: matrix, mkdir: true },
      }),
      read:  singleNodeGraph({
        name: uniqName("csv-read"), action: "csv.read",
        nodeName: "csvr",
        inputs: { path: filePath },
      }),
    })) {
      const g = await createGraph(dsl);
      graphIds[key] = g.id;
      await updateGraph(g.id, dsl);
    }
  });

  afterAll(async () => {
    for (const id of Object.values(graphIds)) await deleteGraph(id);
    try { fs.unlinkSync(filePath); } catch { /* already gone */ }
  });

  test("csv.write serialises a 2D array to disk", async () => {
    const exec = await runGraph(graphIds.write, { expectStatus: "success" });
    const out = nodeOutput(exec, "csvw");
    expect(out.status).toBe("success");
    expect(out.output.path).toBe(filePath);
    expect(out.output.rowCount).toBe(matrix.length - 1); // headers don't count
    expect(fs.existsSync(filePath)).toBe(true);
  });

  test("csv.read parses the file back to objects keyed by header", async () => {
    const exec = await runGraph(graphIds.read, { expectStatus: "success" });
    const out = nodeOutput(exec, "csvr");
    expect(out.status).toBe("success");
    expect(out.output.rowCount).toBe(3);
    expect(out.output.columns).toEqual(["id", "name", "score"]);
    expect(out.output.rows[0]).toMatchObject({ id: 1, name: "alice" });
    // `cast` defaults true so the score comes back as a number.
    expect(typeof out.output.rows[0].score).toBe("number");
  });
});
