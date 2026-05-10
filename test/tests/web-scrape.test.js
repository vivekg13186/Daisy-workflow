// web.scrape — fetches TEST_SCRAPE_URL (defaults to example.com) and
// pulls the page title via a single CSS selector. Lets us prove the
// jsdom path is wired and queries are evaluated.

const { assertServerUp } = require("../helpers/client");
const {
  singleNodeGraph, createGraph, updateGraph, deleteGraph, runGraph,
  uniqName, nodeOutput,
} = require("../helpers/graph");
const { SCRAPE_URL } = require("../helpers/fixtures");

describe("web.scrape", () => {
  let graphId;

  beforeAll(async () => {
    await assertServerUp();
    const dsl = singleNodeGraph({
      name:   uniqName("scrape"),
      action: "web.scrape",
      nodeName: "scrape",
      inputs: {
        url: SCRAPE_URL,
        timeoutMs: 10_000,
        queries: [
          { name: "title", type: "css", selector: "title" },
          { name: "h1",    type: "css", selector: "h1" },
        ],
      },
    });
    const g = await createGraph(dsl);
    graphId = g.id;
    await updateGraph(graphId, dsl);
  });

  afterAll(() => deleteGraph(graphId));

  test("fetches the URL and extracts CSS-matched values", async () => {
    const exec = await runGraph(graphId, { expectStatus: "success", timeoutMs: 20_000 });
    const out = nodeOutput(exec, "scrape");
    expect(out.status).toBe("success");
    expect(out.output.status).toBeGreaterThanOrEqual(200);
    expect(out.output.results).toBeTruthy();
    // example.com always has <title>Example Domain</title> + <h1>Example Domain</h1>.
    // Tests that pin SCRAPE_URL elsewhere should override these expectations.
    expect(typeof out.output.results.title).toBe("string");
    expect(out.output.results.title.length).toBeGreaterThan(0);
  });
});
