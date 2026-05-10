// http.request — round-trips a real GET against TEST_HTTP_URL (defaults
// to httpbin.org/get). If your environment can't reach the public
// internet, set TEST_HTTP_URL to a local mock you control.

const { assertServerUp } = require("../helpers/client");
const {
  singleNodeGraph, createGraph, updateGraph, deleteGraph, runGraph,
  uniqName, nodeOutput,
} = require("../helpers/graph");
const { HTTP_URL } = require("../helpers/fixtures");

describe("http.request", () => {
  let graphId;

  beforeAll(async () => {
    await assertServerUp();
    const dsl = singleNodeGraph({
      name:   uniqName("http"),
      action: "http.request",
      inputs: { url: HTTP_URL, method: "GET", timeoutMs: 10_000 },
    });
    const g = await createGraph(dsl);
    graphId = g.id;
    await updateGraph(graphId, dsl);
  });

  afterAll(() => deleteGraph(graphId));

  test("performs a GET and surfaces status + body", async () => {
    const exec = await runGraph(graphId, { expectStatus: "success", timeoutMs: 20_000 });
    const out = nodeOutput(exec, "http_request");
    expect(out.status).toBe("success");
    expect(out.output.status).toBeGreaterThanOrEqual(200);
    expect(out.output.status).toBeLessThan(300);
    // Body is parsed as JSON when the response is JSON-shaped, otherwise raw text.
    expect(out.output).toHaveProperty("headers");
    expect(out.output).toHaveProperty("body");
  });
});
