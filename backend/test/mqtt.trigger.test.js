// Tests for the MQTT trigger (src/triggers/builtin/mqtt.js).
//
// Run with:  node --test --experimental-test-module-mocks test
//
// We mock the configs loader (so no Postgres is needed) and the mqtt
// connection cache (so no broker is needed) once at file scope, then
// drive incoming messages through the fake client and assert the
// onFire payload shape.

import "./helpers/silenceLog.js";
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { makeFakeClient } from "./helpers/fakeMqtt.js";

// Mutable seams the file-level mocks close over.
let currentConfigs = {};
let currentClient = null;

mock.module("../src/configs/loader.js", {
  namedExports: {
    loadConfigsMap: async () => currentConfigs,
    buildConfigEnv: () => ({}),
  },
});
mock.module("../src/plugins/mqtt/util.js", {
  namedExports: {
    getMqttClient: () => currentClient,
    waitForConnect: async () => {},
  },
});

const { default: trigger } = await import("../src/triggers/builtin/mqtt.js");

beforeEach(() => {
  currentConfigs = {
    broker: { url: "mqtt://x", username: "u", password: "p", clientId: "c1" },
  };
  currentClient = makeFakeClient("mqtt://x");
});

test("subscribe rejects when `config` is missing", async () => {
  await assert.rejects(
    trigger.subscribe({ topic: "t" }, () => {}),
    /`config` is required/,
  );
});

test("subscribe rejects when the named config is missing", async () => {
  currentConfigs = {};
  await assert.rejects(
    trigger.subscribe({ config: "missing", topic: "t" }, () => {}),
    /config "missing" not found/,
  );
});

test("subscribe rejects when the named config has no url", async () => {
  currentConfigs = { broker: { username: "u" } };
  await assert.rejects(
    trigger.subscribe({ config: "broker", topic: "t" }, () => {}),
    /has no url set/,
  );
});

test("subscribe waits to subscribe until the client connects", async () => {
  currentClient.connected = false;
  await trigger.subscribe({ config: "broker", topic: "sensors/+" }, () => {});
  assert.equal(currentClient.subscribed.length, 0, "should not subscribe before connect");
  currentClient.simulateConnect();
  assert.equal(currentClient.subscribed.length, 1);
  assert.deepEqual(currentClient.subscribed[0].topics, ["sensors/+"]);
});

test("subscribe immediately subscribes when client is already connected", async () => {
  currentClient.connected = true;
  await trigger.subscribe({ config: "broker", topic: "sensors/+" }, () => {});
  assert.equal(currentClient.subscribed.length, 1);
});

test("subscribe accepts an array of topics", async () => {
  currentClient.connected = true;
  await trigger.subscribe(
    { config: "broker", topic: ["a/+", "b/#"], qos: 1 },
    () => {},
  );
  assert.deepEqual(currentClient.subscribed[0].topics, ["a/+", "b/#"]);
  assert.equal(currentClient.subscribed[0].opts.qos, 1);
});

test("incoming message fires onFire with parsed JSON by default", async () => {
  currentClient.connected = true;
  const fired = [];
  await trigger.subscribe({ config: "broker", topic: "events" }, (e) => fired.push(e));
  currentClient.simulateMessage(
    "events",
    JSON.stringify({ id: 1, ok: true }),
    { qos: 1, retain: true },
  );
  assert.equal(fired.length, 1);
  assert.equal(fired[0].topic, "events");
  assert.deepEqual(fired[0].message, { id: 1, ok: true });
  assert.equal(fired[0].qos, 1);
  assert.equal(fired[0].retain, true);
  assert.match(fired[0].receivedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("non-JSON payloads survive parseJson:true as raw strings", async () => {
  currentClient.connected = true;
  const fired = [];
  await trigger.subscribe({ config: "broker", topic: "events" }, (e) => fired.push(e));
  currentClient.simulateMessage("events", "not-json");
  assert.equal(fired[0].message, "not-json");
});

test("parseJson:false delivers the raw string even when JSON-shaped", async () => {
  currentClient.connected = true;
  const fired = [];
  await trigger.subscribe(
    { config: "broker", topic: "events", parseJson: false },
    (e) => fired.push(e),
  );
  currentClient.simulateMessage("events", '{"id":1}');
  assert.equal(fired[0].message, '{"id":1}');
});

test("messages stop firing after stop() is called", async () => {
  currentClient.connected = true;
  const fired = [];
  const handle = await trigger.subscribe(
    { config: "broker", topic: "events" },
    (e) => fired.push(e),
  );
  currentClient.simulateMessage("events", "first");
  await handle.stop();
  currentClient.simulateMessage("events", "second");
  assert.equal(fired.length, 1, "post-stop messages must not fire onFire");
  assert.equal(currentClient.unsubscribed.length, 1);
  assert.deepEqual(currentClient.unsubscribed[0], ["events"]);
});

test("reconnect re-subscribes after the broker drops session state", async () => {
  currentClient.connected = true;
  await trigger.subscribe({ config: "broker", topic: "events" }, () => {});
  assert.equal(currentClient.subscribed.length, 1);
  // Simulate a reconnect cycle: reconnect resets the "subscribed" flag,
  // then a fresh "connect" should drive a second subscribe.
  currentClient.emit("reconnect");
  currentClient.emit("connect");
  assert.equal(currentClient.subscribed.length, 2);
});

test("subscribe-failure is logged and the trigger stays alive", async () => {
  currentClient.connected = true;
  // Override subscribe to invoke its callback with an error.
  currentClient.subscribe = (topics, opts, cb) =>
    queueMicrotask(() => cb(new Error("not authorised")));
  const fired = [];
  // No throw — error is logged and the listener is still attached.
  const handle = await trigger.subscribe(
    { config: "broker", topic: "events" },
    (e) => fired.push(e),
  );
  // Yield so the subscribe callback runs.
  await new Promise(r => setImmediate(r));
  // Even though subscribe failed, message events still propagate (the
  // broker may grant the subscription on the next reconnect).
  currentClient.simulateMessage("events", "x");
  assert.equal(fired.length, 1);
  await handle.stop();
});

test("trigger metadata is wired correctly", () => {
  assert.equal(trigger.type, "mqtt");
  assert.deepEqual(trigger.configSchema.required, ["config", "topic"]);
  assert.equal(trigger.configSchema.properties.qos.default, 0);
  assert.equal(trigger.configSchema.properties.parseJson.default, true);
});
