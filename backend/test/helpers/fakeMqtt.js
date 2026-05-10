// Fake mqtt-js client for unit tests.
//
// Exposes the surface area the production code uses:
//   - connect(url, opts)               returns a fake client
//   - client.subscribe(topics, opts, cb)
//   - client.unsubscribe(topics, cb)
//   - client.publish(topic, body, opts, cb)
//   - client.on/off/once/emit          (EventEmitter)
//   - client.connected / disconnected
//   - client.end()
//
// Tests can drive the broker side via:
//   - client.simulateConnect()         emits "connect"
//   - client.simulateMessage(topic, payload, packet)
//   - client.simulateClose()           emits "close" (also marks disconnected)
//
// Each call to connect() pushes the resulting client onto `connections`
// so tests can inspect every connection that was opened by the cache.

import { EventEmitter } from "node:events";

export const connections = [];

/** Reset module-level state between tests. */
export function reset() {
  connections.length = 0;
}

export function makeFakeClient(url, opts = {}) {
  const c = new EventEmitter();
  c.url = url;
  c.options = opts;
  c.connected = false;
  c.disconnected = false;
  c.subscribed = [];
  c.published  = [];
  c.unsubscribed = [];
  let nextMessageId = 1;

  c.subscribe = (topics, subOpts, cb) => {
    if (typeof subOpts === "function") { cb = subOpts; subOpts = undefined; }
    const list = Array.isArray(topics) ? topics : [topics];
    c.subscribed.push({ topics: list, opts: subOpts });
    const granted = list.map(t => ({ topic: t, qos: subOpts?.qos ?? 0 }));
    if (cb) queueMicrotask(() => cb(null, granted));
  };

  c.unsubscribe = (topics, cb) => {
    const list = Array.isArray(topics) ? topics : [topics];
    c.unsubscribed.push(list);
    if (cb) queueMicrotask(() => cb(null));
  };

  c.publish = (topic, body, pubOpts, cb) => {
    if (typeof pubOpts === "function") { cb = pubOpts; pubOpts = undefined; }
    const messageId = nextMessageId++;
    c.published.push({ topic, body, opts: pubOpts, messageId });
    if (cb) queueMicrotask(() => cb(null, { messageId }));
  };

  c.end = (force, endOpts, cb) => {
    if (typeof force === "function") { cb = force; force = undefined; }
    if (typeof endOpts === "function") { cb = endOpts; endOpts = undefined; }
    c.connected = false;
    c.disconnected = true;
    queueMicrotask(() => {
      c.emit("close");
      if (cb) cb();
    });
  };

  // Test helpers -------------------------------------------------------
  c.simulateConnect = () => {
    c.connected = true;
    c.disconnected = false;
    c.emit("connect");
  };
  c.simulateMessage = (topic, payload, packet = {}) => {
    const buf = Buffer.isBuffer(payload) ? payload
      : typeof payload === "string" ? Buffer.from(payload, "utf8")
      : Buffer.from(JSON.stringify(payload), "utf8");
    c.emit("message", topic, buf, { qos: 0, retain: false, ...packet });
  };
  c.simulateError = (err) => c.emit("error", err);
  c.simulateClose = () => {
    c.connected = false;
    c.disconnected = true;
    c.emit("close");
  };

  return c;
}

/**
 * Build a drop-in replacement for `import mqtt from 'mqtt'`. Shaped for
 * node:test's mock.module(): the default export carries `connect`, and
 * `connect` is also exported as a named export so either import style
 * resolves to the same factory.
 */
export function makeFakeMqttModule({ failOnConnect } = {}) {
  function fakeConnect(url, opts) {
    const c = makeFakeClient(url, opts);
    connections.push(c);
    if (failOnConnect) queueMicrotask(() => c.simulateError(new Error(failOnConnect)));
    return c;
  }
  return {
    defaultExport: { connect: fakeConnect },
    namedExports: { connect: fakeConnect },
  };
}
