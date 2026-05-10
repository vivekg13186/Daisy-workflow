// file.* — drives the full filesystem lifecycle: write a file, stat it,
// list its directory, read it back, then delete it. Each operation
// runs through its own one-node graph so failures point at a specific
// plugin.
//
// Paths live under TEST_TMP_DIR (defaults to <os.tmpdir>/dag-engine-livetest).
// If your backend has FILE_ROOT set, point TEST_TMP_DIR at a path
// inside that root.

const fs = require("fs");
const { assertServerUp } = require("../helpers/client");
const {
  singleNodeGraph, createGraph, updateGraph, deleteGraph, runGraph,
  uniqName, nodeOutput,
} = require("../helpers/graph");
const { tmpPath } = require("../helpers/fixtures");

describe("file.*", () => {
  const filePath = tmpPath(`livetest-${Date.now()}.txt`);
  const dirPath  = filePath.replace(/\/[^/]+$/, "");
  const content  = "hello-from-livetest\n";

  // Each plugin gets its own graph so the recorded ctx.nodes entries
  // are unambiguous; we collect ids here to clean them all up at end.
  const graphIds = {};

  beforeAll(async () => {
    await assertServerUp();
    fs.mkdirSync(dirPath, { recursive: true });

    for (const [key, dsl] of Object.entries({
      write:  singleNodeGraph({
        name: uniqName("file-write"), action: "file.write",
        nodeName: "fwrite",
        inputs: { path: filePath, content, mkdir: true },
      }),
      stat:   singleNodeGraph({
        name: uniqName("file-stat"), action: "file.stat",
        nodeName: "fstat",
        inputs: { path: filePath },
      }),
      list:   singleNodeGraph({
        name: uniqName("file-list"), action: "file.list",
        nodeName: "flist",
        inputs: { path: dirPath, pattern: "livetest-*.txt" },
      }),
      read:   singleNodeGraph({
        name: uniqName("file-read"), action: "file.read",
        nodeName: "fread",
        inputs: { path: filePath },
      }),
      del:    singleNodeGraph({
        name: uniqName("file-delete"), action: "file.delete",
        nodeName: "fdel",
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

  test("file.write creates the file and reports its size", async () => {
    const exec = await runGraph(graphIds.write, { expectStatus: "success" });
    const out = nodeOutput(exec, "fwrite");
    expect(out.status).toBe("success");
    expect(out.output.path).toBe(filePath);
    expect(out.output.size).toBe(Buffer.byteLength(content));
  });

  test("file.stat reports exists:true with type + size after the write", async () => {
    const exec = await runGraph(graphIds.stat, { expectStatus: "success" });
    const out = nodeOutput(exec, "fstat");
    expect(out.status).toBe("success");
    expect(out.output.exists).toBe(true);
    expect(out.output.isFile).toBe(true);
    expect(out.output.size).toBe(Buffer.byteLength(content));
  });

  test("file.list returns the file under its glob filter", async () => {
    const exec = await runGraph(graphIds.list, { expectStatus: "success" });
    const out = nodeOutput(exec, "flist");
    expect(out.status).toBe("success");
    const found = out.output.entries.find(e => e.path === filePath);
    expect(found).toBeTruthy();
    expect(found.isFile).toBe(true);
  });

  test("file.read returns the original content verbatim", async () => {
    const exec = await runGraph(graphIds.read, { expectStatus: "success" });
    const out = nodeOutput(exec, "fread");
    expect(out.status).toBe("success");
    expect(out.output.content).toBe(content);
    expect(out.output.encoding).toBe("utf8");
  });

  test("file.delete removes the file", async () => {
    const exec = await runGraph(graphIds.del, { expectStatus: "success" });
    const out = nodeOutput(exec, "fdel");
    expect(out.status).toBe("success");
    expect(out.output.deleted).toBe(true);
    expect(fs.existsSync(filePath)).toBe(false);
  });
});
