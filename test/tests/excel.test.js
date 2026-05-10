// excel.* — write a 2D array to an .xlsx file then read it back via
// excel.read. Same shape as csv.test, just with the workbook plugin.

const fs = require("fs");
const { assertServerUp } = require("../helpers/client");
const {
  singleNodeGraph, createGraph, updateGraph, deleteGraph, runGraph,
  uniqName, nodeOutput,
} = require("../helpers/graph");
const { tmpPath } = require("../helpers/fixtures");

describe("excel.*", () => {
  const filePath = tmpPath(`livetest-${Date.now()}.xlsx`);
  const matrix = [
    ["sku",  "qty", "price"],
    ["a-1",   3,    1.50  ],
    ["b-2",   7,    9.99  ],
  ];
  const graphIds = {};

  beforeAll(async () => {
    await assertServerUp();
    for (const [key, dsl] of Object.entries({
      write: singleNodeGraph({
        name: uniqName("xlsx-write"), action: "excel.write",
        nodeName: "xlsxw",
        inputs: { path: filePath, sheet: "Sheet1", data: matrix, mkdir: true },
      }),
      read:  singleNodeGraph({
        name: uniqName("xlsx-read"), action: "excel.read",
        nodeName: "xlsxr",
        inputs: { path: filePath, sheet: "Sheet1", headers: true },
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

  test("excel.write writes the workbook to disk", async () => {
    const exec = await runGraph(graphIds.write, { expectStatus: "success" });
    const out = nodeOutput(exec, "xlsxw");
    expect(out.status).toBe("success");
    expect(out.output.path).toBe(filePath);
    expect(out.output.rowCount).toBe(2);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  test("excel.read parses the workbook back to keyed objects", async () => {
    const exec = await runGraph(graphIds.read, { expectStatus: "success" });
    const out = nodeOutput(exec, "xlsxr");
    expect(out.status).toBe("success");
    expect(out.output.rowCount).toBe(2);
    expect(out.output.columns).toEqual(["sku", "qty", "price"]);
    expect(out.output.rows[0]).toMatchObject({ sku: "a-1", qty: 3 });
  });
});
