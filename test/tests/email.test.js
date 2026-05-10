// email.send — fires through the test_send_email config (a stored
// mail.smtp config in your DAG-engine instance). The test only asserts
// the node finished and that nodemailer returned a messageId; whether
// the email is actually delivered depends on the SMTP server you've
// configured (Mailpit / sendmail / real SMTP).

const { assertServerUp } = require("../helpers/client");
const {
  singleNodeGraph, createGraph, updateGraph, deleteGraph, runGraph,
  uniqName, nodeOutput,
} = require("../helpers/graph");
const { CONFIGS } = require("../helpers/fixtures");

describe("email.send", () => {
  let graphId;

  beforeAll(async () => {
    await assertServerUp();
    const dsl = singleNodeGraph({
      name:   uniqName("email"),
      action: "email.send",
      nodeName: "send_mail",
      inputs: {
        config:  CONFIGS.email,
        to:      "vivek.ilionx.25@gmail.com",
        subject: "DAG-engine livetest",
        text:    "This message was sent by the live integration test suite.",
      },
    });
    const g = await createGraph(dsl);
    graphId = g.id;
    await updateGraph(graphId, dsl);
  });

  afterAll(() => deleteGraph(graphId));

  test("sends through the configured SMTP transport", async () => {
    const exec = await runGraph(graphId, { expectStatus: "success" });
    const out = nodeOutput(exec, "send_mail");
    expect(out.status).toBe("success");
    // Transports return a messageId on success (real SMTP) — for jsonTransport
    // dry-run setups we get a synthetic id; either way it should be present.
    expect(out.output).toHaveProperty("messageId");
    // accepted should include the recipient unless the transport is fully dry.
    expect(Array.isArray(out.output.accepted)).toBe(true);
  });
});
