// Webhook trigger.
//
// Unlike schedule / mqtt / email, webhook triggers are SERVER-SIDE endpoints,
// not outbound subscriptions. The actual HTTP handling lives in the API
// (src/api/webhooks.js). This file is mainly here so the trigger appears in
// /triggers/types for discovery + the config schema is validated on create.
//
// Config:
//   methods:        ["POST"]   array of allowed HTTP methods (default: any of GET/POST/PUT/PATCH/DELETE)
//   secret:         "..."      optional shared secret; if set, callers must send it as
//                              X-Webhook-Secret header (or ?secret=... query param)
//
// Payload passed to the workflow:
//   { method, path, url, headers, query, body, remoteAddr, receivedAt }

export default {
  type: "webhook",
  description: "Fires when an HTTP request hits /webhooks/<id>. Optional method whitelist + shared secret.",
  configSchema: {
    type: "object",
    properties: {
      methods: {
        type: "array",
        items: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "ANY"] },
        default: ["POST"],
      },
      secret: { type: "string" },
    },
  },

  // Webhooks have no outbound subscription — the API route fires the trigger
  // directly when a request lands. We still implement subscribe()/stop() so
  // the manager can register the trigger and surface "running" status in the
  // UI; the no-op handler simply lets the manager do its bookkeeping.
  async subscribe(_config, _onFire) {
    return { stop: async () => {} };
  },
};
