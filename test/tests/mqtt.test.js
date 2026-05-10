// mqtt.publish — pushes a message at the broker named by the test_mqtt
// config. We can't easily round-trip-subscribe from the test process
// (the trigger lives inside the worker), so we only assert that the
// publish itself succeeded and the broker echoed back the metadata.

const { assertServerUp } = require("../helpers/client");
const {
  singleNodeGraph, createGraph, updateGraph, deleteGraph, runGraph,
  uniqName, nodeOutput,
} = require("../helpers/graph");
const { CONFIGS } = require("../helpers/fixtures");

describe("mqtt.publish", () => {
  let graphId;
  const topic = `dag-engine/livetest/${Date.now()}`;
  const payload = { hello: "from livetest", at: new Date().toISOString() };

  beforeAll(async () => {
    await assertServerUp();
    const dsl = singleNodeGraph({
      name:   uniqName("mqtt"),
      action: "mqtt.publish",
      nodeName: "publish",
      inputs: {
        config:  CONFIGS.mqtt,
        topic,
        payload,
        qos:     0,
        retain:  false,
      },
    });
    const g = await createGraph(dsl);
    graphId = g.id;
    await updateGraph(graphId, dsl);
  });

  afterAll(() => deleteGraph(graphId));

  test("publishes a JSON-serialised payload to the broker", async () => {
    const exec = await runGraph(graphId, { expectStatus: "success", timeoutMs: 20_000 });
    const out = nodeOutput(exec, "publish");
    expect(out.status).toBe("success");
    expect(out.output.topic).toBe(topic);
    expect(out.output.qos).toBe(0);
    expect(out.output.retain).toBe(false);
    // The plugin JSON-stringifies object payloads, so byte count should
    // equal the JSON length of what we sent.
    expect(out.output.bytes).toBe(Buffer.byteLength(JSON.stringify(payload)));
  });
});
