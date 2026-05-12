// Shared MQTT connection cache.
//
// Both the mqtt.publish action plugin and the MQTT trigger talk to a
// broker through this module. Keying by url + username + clientId keeps
// the pool small while still letting multiple identities share a single
// process. Connections live for the lifetime of the worker.
//
// Lives outside src/plugins/builtin/ so the auto-loader doesn't try to
// register it as an action.

import mqtt from "mqtt";
import { randomBytes } from "node:crypto";
import { log } from "../../utils/logger.js";

const cache = new Map();   // key -> mqtt.Client

function key(opts) {
  return JSON.stringify([opts.url, opts.username || "", opts.clientId || ""]);
}

/**
 * Return a connected mqtt.js client for the given options. Reuses an
 * existing pool entry when the URL + credentials + clientId match.
 *
 * @param {object} opts
 *   - url:      "mqtt://… | mqtts://… | ws://… | wss://…"      (required)
 *   - username: string                                          (optional)
 *   - password: string                                          (optional)
 *   - clientId: string                                          (auto-generated if missing)
 */
export function getMqttClient(opts) {
  if (!opts?.url) {
    throw new Error("mqtt: connection requires a url (mqtt://… or mqtts://…)");
  }
  const k = key(opts);
  let client = cache.get(k);
  if (client && !client.disconnected) return client;

  const clientId = opts.clientId || `dag-engine-${randomBytes(4).toString("hex")}`;
  client = mqtt.connect(opts.url, {
    clientId,
    username:        opts.username,
    password:        opts.password,
    reconnectPeriod: 5000,
    connectTimeout:  15000,
  });

  client.on("error",     (e) => log.warn("mqtt error",      { url: opts.url, error: e.message }));
  client.on("reconnect", ()  => log.info("mqtt reconnect",  { url: opts.url }));
  client.on("offline",   ()  => log.warn("mqtt offline",    { url: opts.url }));
  // Auto-evict on close so the next caller reconnects fresh rather than
  // pinning to a dead client.
  client.on("close",     () => {
    if (cache.get(k) === client) cache.delete(k);
  });

  cache.set(k, client);
  return client;
}

/**
 * Tear down + evict cached clients whose URL matches `url` (and, if
 * provided, also match `username` / `clientId`). Used when a stored mqtt
 * configuration row changes — the trigger manager force-restarts the
 * subscription, but without dropping the cached TCP connection the
 * next `getMqttClient` call would still hand out the old socket.
 *
 * Safe to call with a URL that isn't currently cached.
 */
export function evictMqttClient({ url, username, clientId } = {}) {
  if (!url) return 0;
  let dropped = 0;
  for (const [k, client] of cache.entries()) {
    let parts;
    try { parts = JSON.parse(k); } catch { continue; }
    if (parts[0] !== url) continue;
    if (username != null && parts[1] !== username) continue;
    if (clientId != null && parts[2] !== clientId) continue;
    try { client.end(true, () => {}); } catch { /* ignore */ }
    cache.delete(k);
    dropped++;
  }
  if (dropped) log.info("mqtt clients evicted", { url, dropped });
  return dropped;
}

/** Wait until the client is in a publishable state, with a soft timeout. */
export function waitForConnect(client, timeoutMs = 10000) {
  if (client.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onConnect = () => { cleanup(); resolve(); };
    const onError   = (e) => { cleanup(); reject(e); };
    const t = setTimeout(() => { cleanup(); reject(new Error("mqtt: connect timed out")); }, timeoutMs);
    function cleanup() {
      clearTimeout(t);
      client.off("connect", onConnect);
      client.off("error", onError);
    }
    client.once("connect", onConnect);
    client.once("error",   onError);
  });
}
