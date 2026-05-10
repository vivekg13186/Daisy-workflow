// Tests for the shared MQTT connection cache (src/plugins/mqtt/util.js).
//
// Run with:  node --test --experimental-test-module-mocks test
//
// The mqtt.js client is replaced with a fake module so we can assert on
// connect options, exercise reconnection and close-eviction paths, and
// confirm waitForConnect handles connect/error/timeout without doing
// network I/O.
//
// All tests share a single import of util.js (so coverage attributes
// to the canonical path); to keep them isolated we pick unique URLs +
// clientIds per test rather than clearing the in-module cache.

import "./helpers/silenceLog.js";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { connections, makeFakeMqttModule } from "./helpers/fakeMqtt.js";

// File-level mock — persists for every test in this file.
mock.module("mqtt", makeFakeMqttModule());
const { getMqttClient, waitForConnect } = await import("../src/plugins/mqtt/util.js");

// Slice the connections array off the start of each test so previous
// tests' connections don't leak into assertions about counts.
function freshConnectionsView() {
  const start = connections.length;
  return () => connections.slice(start);
}

test("getMqttClient throws when url is missing", () => {
  assert.throws(() => getMqttClient({}), /requires a url/);
  assert.throws(() => getMqttClient(null), /requires a url/);
  assert.throws(() => getMqttClient({ url: "" }), /requires a url/);
});

test("getMqttClient passes url + credentials through to mqtt.connect", () => {
  const view = freshConnectionsView();
  const c = getMqttClient({
    url: "mqtt://broker-pass.local:1883",
    username: "alice",
    password: "s3cret",
    clientId: "fixed-pass",
  });
  const fresh = view();
  assert.equal(fresh.length, 1);
  assert.equal(c.url, "mqtt://broker-pass.local:1883");
  assert.equal(c.options.username, "alice");
  assert.equal(c.options.password, "s3cret");
  assert.equal(c.options.clientId, "fixed-pass");
});

test("getMqttClient generates a clientId when none is provided", () => {
  const view = freshConnectionsView();
  getMqttClient({ url: "mqtt://broker-auto.local" });
  assert.match(view()[0].options.clientId, /^dag-engine-[0-9a-f]{8}$/);
});

test("getMqttClient reuses the cached client for matching options", () => {
  const view = freshConnectionsView();
  const a = getMqttClient({ url: "mqtt://reuse.local", username: "u", clientId: "reuse-c1" });
  const b = getMqttClient({ url: "mqtt://reuse.local", username: "u", clientId: "reuse-c1" });
  assert.equal(a, b);
  assert.equal(view().length, 1);
});

test("getMqttClient keys cache on url + username + clientId", () => {
  const view = freshConnectionsView();
  getMqttClient({ url: "mqtt://keytest.local", username: "ku1", clientId: "kc1" });
  getMqttClient({ url: "mqtt://keytest.local", username: "ku2", clientId: "kc1" }); // diff user
  getMqttClient({ url: "mqtt://keytest.local", username: "ku1", clientId: "kc2" }); // diff client
  getMqttClient({ url: "mqtt://keytest2.local", username: "ku1", clientId: "kc1" }); // diff url
  // password is intentionally NOT part of the key.
  getMqttClient({
    url: "mqtt://keytest.local", username: "ku1", clientId: "kc1", password: "ignored",
  });
  assert.equal(view().length, 4);
});

test("getMqttClient does not reuse a disconnected client", () => {
  const view = freshConnectionsView();
  const first = getMqttClient({ url: "mqtt://disc.local", clientId: "disc-c" });
  first.disconnected = true;
  const second = getMqttClient({ url: "mqtt://disc.local", clientId: "disc-c" });
  assert.notEqual(first, second);
  assert.equal(view().length, 2);
});

test("client close evicts the cache so the next call reconnects", async () => {
  const view = freshConnectionsView();
  const first = getMqttClient({ url: "mqtt://close.local", clientId: "close-c" });
  first.simulateClose();
  // Yield once so the close handler fires before we call again.
  await new Promise(r => setImmediate(r));
  const second = getMqttClient({ url: "mqtt://close.local", clientId: "close-c" });
  assert.notEqual(first, second);
  assert.equal(view().length, 2);
});

test("waitForConnect resolves immediately when already connected", async () => {
  const c = getMqttClient({ url: "mqtt://wait1.local", clientId: "wait1-c" });
  c.connected = true;
  await waitForConnect(c);
});

test("waitForConnect resolves on a connect event", async () => {
  const c = getMqttClient({ url: "mqtt://wait2.local", clientId: "wait2-c" });
  c.connected = false;
  setImmediate(() => c.simulateConnect());
  await waitForConnect(c, 1000);
  assert.equal(c.connected, true);
});

test("waitForConnect rejects on an error event", async () => {
  const c = getMqttClient({ url: "mqtt://wait3.local", clientId: "wait3-c" });
  c.connected = false;
  setImmediate(() => c.simulateError(new Error("boom")));
  await assert.rejects(waitForConnect(c, 1000), /boom/);
});

test("waitForConnect times out", async () => {
  const c = getMqttClient({ url: "mqtt://wait4.local", clientId: "wait4-c" });
  c.connected = false;
  await assert.rejects(waitForConnect(c, 25), /timed out/);
});
