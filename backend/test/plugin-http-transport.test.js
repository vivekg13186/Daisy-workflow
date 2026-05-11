// Plugin HTTP transport — verifies the wire shape of invokeOverHttp
// and the install-from-endpoint flow without spinning up a real
// plugin container.
//
//   npm test
//
// We override the global `fetch` so each test can capture the
// outbound request and return a stubbed response. No mocks of the
// pool (the registry's loadAll path tolerates the table being
// missing, so the bare invoke path works in isolation).

import { test, mock } from "node:test";
import assert from "node:assert/strict";

// Stub the db pool so install.js's INSERT doesn't actually need
// Postgres. Same pattern as audit + retention tests.
const calls = [];
mock.module("../src/db/pool.js", {
  namedExports: {
    pool: {
      async query(sql, params) {
        calls.push({ sql, params });
        return { rowCount: 1, rows: [] };
      },
    },
  },
});

const { installFromEndpoint } = await import("../src/plugins/install.js");

function withFetchMock(fakeFetch) {
  const original = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  return () => { globalThis.fetch = original; };
}

// ────────────────────────────────────────────────────────────────────
// install.js
// ────────────────────────────────────────────────────────────────────

const VALID_MANIFEST = {
  name:        "reddit.search",
  version:     "0.1.0",
  description: "Example plugin",
  primaryOutput: "posts",
  inputSchema:   { type: "object", required: ["query"], properties: { query: { type: "string" } } },
  outputSchema:  { type: "object", properties: { posts: { type: "array" } } },
};

test("installFromEndpoint: success path persists row + reports healthy", async () => {
  calls.length = 0;
  const restore = withFetchMock(async (url, opts) => {
    if (url.endsWith("/manifest")) {
      return new Response(JSON.stringify(VALID_MANIFEST), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/readyz")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    throw new Error("unexpected url " + url);
  });
  try {
    const r = await installFromEndpoint({ endpoint: "http://plugin.test:8080" });
    assert.equal(r.name,      "reddit.search");
    assert.equal(r.version,   "0.1.0");
    assert.equal(r.transport, "http");
    assert.equal(r.endpoint,  "http://plugin.test:8080");
    assert.equal(r.status,    "healthy");

    // Verify the INSERT actually got the manifest blob.
    const insert = calls.find(c => /INSERT INTO plugins/.test(c.sql));
    assert.ok(insert, "should have run INSERT");
    const params = insert.params;
    // Phase 3 shape:
    //   [name, version, manifest, transport, endpoint, source,
    //    status, lastError, manifestSha256, catalogEntryUrl,
    //    homepage, category, tags]
    assert.equal(params[0], "reddit.search");
    assert.equal(params[1], "0.1.0");
    assert.match(params[2], /"name":"reddit\.search"/);
    assert.equal(params[3], "http");
    assert.equal(params[4], "http://plugin.test:8080");
    assert.equal(params[6], "healthy");
  } finally { restore(); }
});

test("installFromEndpoint: readyz failure records degraded but still installs", async () => {
  calls.length = 0;
  const restore = withFetchMock(async (url) => {
    if (url.endsWith("/manifest")) return new Response(JSON.stringify(VALID_MANIFEST), { status: 200 });
    if (url.endsWith("/readyz"))   return new Response("nope", { status: 503 });
    throw new Error("unexpected " + url);
  });
  try {
    const r = await installFromEndpoint({ endpoint: "http://plugin.test:8080" });
    assert.equal(r.status, "degraded");
  } finally { restore(); }
});

test("installFromEndpoint: rejects manifest with non-semver version", async () => {
  const restore = withFetchMock(async (url) => {
    if (url.endsWith("/manifest"))
      return new Response(JSON.stringify({ ...VALID_MANIFEST, version: "latest" }), { status: 200 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  try {
    await assert.rejects(
      () => installFromEndpoint({ endpoint: "http://plugin.test:8080" }),
      /version must be semver/,
    );
  } finally { restore(); }
});

test("installFromEndpoint: rejects manifest with illegal name", async () => {
  const restore = withFetchMock(async (url) => {
    if (url.endsWith("/manifest"))
      return new Response(JSON.stringify({ ...VALID_MANIFEST, name: "Has Spaces!" }), { status: 200 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  try {
    await assert.rejects(
      () => installFromEndpoint({ endpoint: "http://plugin.test:8080" }),
      /name must be a dotted-string/,
    );
  } finally { restore(); }
});

test("installFromEndpoint: rejects 404 on /manifest", async () => {
  const restore = withFetchMock(async () => new Response("not found", { status: 404 }));
  try {
    await assert.rejects(
      () => installFromEndpoint({ endpoint: "http://plugin.test:8080" }),
      /HTTP 404/,
    );
  } finally { restore(); }
});
