// Tests for the mqtt.publish action plugin.
//
// Run with:  node --test --experimental-test-module-mocks test
//
// The plugin only talks to the broker through getMqttClient() /
// waitForConnect() so we mock those once at file scope, drop a fresh
// fake client into the seam per test via a mutable factory, and inspect
// the (topic, body, opts) the plugin pushed onto it.

import "./helpers/silenceLog.js";
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { makeFakeClient } from "./helpers/fakeMqtt.js";

// Shared mutable seam: each test sets `currentClient` and `waitImpl`;
// the mock implementations below close over them so that one file-level
// mock can serve every test.
let currentClient = null;
let waitImpl = async () => {};

mock.module("../src/plugins/mqtt/util.js", {
  namedExports: {
    getMqttClient: () => currentClient,
    waitForConnect: async (...args) => waitImpl(...args),
  },
});

const { default: plugin } = await import("../src/plugins/builtin/mqtt.publish.js");

beforeEach(() => {
  currentClient = makeFakeClient("mqtt://x");
  currentClient.connected = true;
  waitImpl = async () => {};
});

test("execute throws when ctx.config is missing the named entry", async () => {
  await assert.rejects(
    plugin.execute({ config: "nope", topic: "t", payload: "p" }, { config: {} }),
    /config "nope" not found/,
  );
});

test("execute throws when ctx.config is undefined", async () => {
  await assert.rejects(
    plugin.execute({ config: "broker", topic: "t", payload: "p" }, {}),
    /config "broker" not found/,
  );
});

test("execute throws when the named config has no url", async () => {
  await assert.rejects(
    plugin.execute(
      { config: "broker", topic: "t", payload: "p" },
      { config: { broker: { username: "u" } } },
    ),
    /has no url set/,
  );
});

test("execute publishes a string payload verbatim", async () => {
  const out = await plugin.execute(
    { config: "broker", topic: "sensors/a", payload: "hello" },
    { config: { broker: { url: "mqtt://x" } } },
  );
  assert.equal(currentClient.published.length, 1);
  const sent = currentClient.published[0];
  assert.equal(sent.topic, "sensors/a");
  assert.equal(sent.body, "hello");
  assert.equal(sent.opts.qos, 0);
  assert.equal(sent.opts.retain, false);
  assert.deepEqual(out, {
    topic:     "sensors/a",
    bytes:     5,
    qos:       0,
    retain:    false,
    messageId: sent.messageId,
  });
});

test("execute JSON-stringifies object payloads", async () => {
  const out = await plugin.execute(
    { config: "broker", topic: "events", payload: { id: 1, ok: true } },
    { config: { broker: { url: "mqtt://x" } } },
  );
  assert.equal(currentClient.published[0].body, '{"id":1,"ok":true}');
  assert.equal(out.bytes, '{"id":1,"ok":true}'.length);
});

test("execute passes Buffer payloads through unchanged", async () => {
  const buf = Buffer.from([0x01, 0x02, 0x03, 0x04]);
  const out = await plugin.execute(
    { config: "broker", topic: "raw", payload: buf },
    { config: { broker: { url: "mqtt://x" } } },
  );
  assert.equal(currentClient.published[0].body, buf);
  assert.equal(out.bytes, 4);
});

test("execute treats a null payload as empty string", async () => {
  const out = await plugin.execute(
    { config: "broker", topic: "t", payload: null },
    { config: { broker: { url: "mqtt://x" } } },
  );
  assert.equal(currentClient.published[0].body, "");
  assert.equal(out.bytes, 0);
});

test("execute treats an undefined payload as empty string", async () => {
  const out = await plugin.execute(
    { config: "broker", topic: "t", payload: undefined },
    { config: { broker: { url: "mqtt://x" } } },
  );
  assert.equal(currentClient.published[0].body, "");
  assert.equal(out.bytes, 0);
});

test("execute honours qos and retain", async () => {
  const out = await plugin.execute(
    { config: "broker", topic: "t", payload: "x", qos: 2, retain: true },
    { config: { broker: { url: "mqtt://x" } } },
  );
  assert.equal(currentClient.published[0].opts.qos, 2);
  assert.equal(currentClient.published[0].opts.retain, true);
  assert.equal(out.qos, 2);
  assert.equal(out.retain, true);
});

test("execute defaults qos=0 and retain=false when input omits them", async () => {
  await plugin.execute(
    { config: "broker", topic: "t", payload: "x" },
    { config: { broker: { url: "mqtt://x" } } },
  );
  assert.equal(currentClient.published[0].opts.qos, 0);
  assert.equal(currentClient.published[0].opts.retain, false);
});

test("execute surfaces broker publish errors", async () => {
  // Override publish to simulate a broker-side rejection.
  currentClient.publish = (topic, body, opts, cb) =>
    queueMicrotask(() => cb(new Error("disconnected")));
  await assert.rejects(
    plugin.execute(
      { config: "broker", topic: "t", payload: "x" },
      { config: { broker: { url: "mqtt://x" } } },
    ),
    /disconnected/,
  );
});

test("execute waits for connect before publishing", async () => {
  let waited = false;
  waitImpl = async () => { waited = true; };
  await plugin.execute(
    { config: "broker", topic: "t", payload: "x" },
    { config: { broker: { url: "mqtt://x" } } },
  );
  assert.equal(waited, true, "waitForConnect should be awaited before publish");
  assert.equal(currentClient.published.length, 1);
});

test("execute returns the broker-assigned messageId", async () => {
  currentClient.publish = (topic, body, opts, cb) =>
    queueMicrotask(() => cb(null, { messageId: 4242 }));
  const out = await plugin.execute(
    { config: "broker", topic: "t", payload: "x" },
    { config: { broker: { url: "mqtt://x" } } },
  );
  assert.equal(out.messageId, 4242);
});

test("plugin metadata is wired correctly", () => {
  assert.equal(plugin.name, "mqtt.publish");
  assert.equal(plugin.primaryOutput, "messageId");
  assert.deepEqual(plugin.inputSchema.required, ["config", "topic", "payload"]);
  assert.equal(plugin.inputSchema.properties.qos.default, 0);
  assert.equal(plugin.inputSchema.properties.retain.default, false);
});
