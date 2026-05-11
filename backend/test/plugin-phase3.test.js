// Plugin Phase 3 — covers the three pieces of behaviour the
// Phase 3 refactor introduces and which aren't already covered
// by plugin-http-transport.test.js:
//
//   1. parsePluginRef() — DSL action string → { name, version }
//   2. installFromCatalog() — manifest checksum verification
//   3. catalog.js — local-disk fallback + schema validation
//
//   npm test
//
// Same pattern as the Phase 1 transport test: stub the db pool so
// INSERTs don't need Postgres, mock global fetch per-case to feed
// stubbed responses to install.js.

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Stub the db pool BEFORE importing install.js / registry.js.
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

const { installFromCatalog }       = await import("../src/plugins/install.js");
const { parsePluginRef }           = await import("../src/plugins/registry.js");
const { loadCatalog }              = await import("../src/plugins/catalog.js");

function withFetchMock(fakeFetch) {
  const original = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  return () => { globalThis.fetch = original; };
}

// ────────────────────────────────────────────────────────────────────
// parsePluginRef
// ────────────────────────────────────────────────────────────────────

test("parsePluginRef: bare name returns null version", () => {
  assert.deepEqual(parsePluginRef("reddit.search"), { name: "reddit.search", version: null });
});

test("parsePluginRef: name@version splits on the @", () => {
  assert.deepEqual(parsePluginRef("reddit.search@0.1.0"), { name: "reddit.search", version: "0.1.0" });
});

test("parsePluginRef: trailing whitespace tolerated", () => {
  assert.deepEqual(parsePluginRef("  reddit.search@1.2.3  "), { name: "reddit.search", version: "1.2.3" });
});

test("parsePluginRef: name@ with empty version is treated as unpinned", () => {
  // operator typo — degrade gracefully to "no pin" rather than
  // throwing, so the engine returns the default version.
  assert.deepEqual(parsePluginRef("reddit.search@"), { name: "reddit.search", version: null });
});

test("parsePluginRef: rejects empty / non-string input", () => {
  assert.throws(() => parsePluginRef(""),       /non-empty string/);
  assert.throws(() => parsePluginRef(null),     /non-empty string/);
  assert.throws(() => parsePluginRef(undefined),/non-empty string/);
  assert.throws(() => parsePluginRef(42),       /non-empty string/);
});

// ────────────────────────────────────────────────────────────────────
// installFromCatalog — checksum verification
// ────────────────────────────────────────────────────────────────────

const VALID_MANIFEST = {
  name:         "reddit.search",
  version:      "0.1.0",
  description:  "Example plugin",
  primaryOutput: "posts",
  inputSchema:  { type: "object", required: ["query"], properties: { query: { type: "string" } } },
  outputSchema: { type: "object", properties: { posts: { type: "array" } } },
};

function sha256(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

test("installFromCatalog: success path computes + persists the SHA-256", async () => {
  calls.length = 0;
  const body = JSON.stringify(VALID_MANIFEST);
  const expected = sha256(body);
  const restore = withFetchMock(async (url) => {
    if (url.endsWith("/manifest.json")) {
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/readyz")) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    throw new Error("unexpected url " + url);
  });
  try {
    const r = await installFromCatalog({
      manifestUrl:     "https://catalog.example.com/reddit/manifest.json",
      manifestSha256:  expected,
      endpoint:        "http://plugin.test:8080",
      catalogEntryUrl: "https://catalog.example.com/#reddit.search@0.1.0",
    });
    assert.equal(r.name,           "reddit.search");
    assert.equal(r.version,        "0.1.0");
    assert.equal(r.status,         "healthy");
    assert.equal(r.manifestSha256, expected);
    // source defaults to "marketplace:<catalogEntryUrl>"
    assert.match(r.source, /^marketplace:/);
  } finally { restore(); }
});

test("installFromCatalog: rejects when declared SHA-256 doesn't match body", async () => {
  const body = JSON.stringify(VALID_MANIFEST);
  // Wrong hash on purpose — install must refuse to persist.
  const restore = withFetchMock(async (url) => {
    if (url.endsWith("/manifest.json")) return new Response(body, { status: 200 });
    return new Response("ok", { status: 200 });
  });
  try {
    await assert.rejects(
      () => installFromCatalog({
        manifestUrl:    "https://catalog.example.com/reddit/manifest.json",
        manifestSha256: "0".repeat(64),
        endpoint:       "http://plugin.test:8080",
      }),
      /checksum mismatch/,
    );
  } finally { restore(); }
});

test("installFromCatalog: tolerates missing checksum (catalog without manifestSha256)", async () => {
  const body = JSON.stringify(VALID_MANIFEST);
  const restore = withFetchMock(async (url) => {
    if (url.endsWith("/manifest.json")) return new Response(body, { status: 200 });
    return new Response("ok", { status: 200 });
  });
  try {
    const r = await installFromCatalog({
      manifestUrl:    "https://catalog.example.com/reddit/manifest.json",
      manifestSha256: null,            // omitted — install still proceeds
      endpoint:       "http://plugin.test:8080",
    });
    // We still record the *computed* hash on the row so admins
    // can lock the catalog down later.
    assert.equal(r.manifestSha256, sha256(body));
  } finally { restore(); }
});

test("installFromCatalog: comparison is case-insensitive", async () => {
  const body = JSON.stringify(VALID_MANIFEST);
  const expected = sha256(body).toUpperCase();
  const restore = withFetchMock(async (url) => {
    if (url.endsWith("/manifest.json")) return new Response(body, { status: 200 });
    return new Response("ok", { status: 200 });
  });
  try {
    const r = await installFromCatalog({
      manifestUrl:    "https://catalog.example.com/reddit/manifest.json",
      manifestSha256: expected,      // uppercase hex — must still match
      endpoint:       "http://plugin.test:8080",
    });
    assert.equal(r.manifestSha256, expected.toLowerCase());
  } finally { restore(); }
});

test("installFromCatalog: degraded status when /readyz fails", async () => {
  const body = JSON.stringify(VALID_MANIFEST);
  const restore = withFetchMock(async (url) => {
    if (url.endsWith("/manifest.json")) return new Response(body, { status: 200 });
    if (url.endsWith("/readyz"))        return new Response("nope", { status: 503 });
    throw new Error("unexpected " + url);
  });
  try {
    const r = await installFromCatalog({
      manifestUrl: "https://catalog.example.com/reddit/manifest.json",
      endpoint:    "http://plugin.test:8080",
    });
    assert.equal(r.status, "degraded");
  } finally { restore(); }
});

// ────────────────────────────────────────────────────────────────────
// catalog.js — local-disk fallback + schema validation
// ────────────────────────────────────────────────────────────────────

function writeTmpCatalog(json) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "daisy-catalog-"));
  const f   = path.join(dir, "catalog.json");
  fs.writeFileSync(f, typeof json === "string" ? json : JSON.stringify(json));
  return f;
}

test("loadCatalog: reads a local-disk fallback file when PLUGIN_CATALOG_URL is unset", async () => {
  const f = writeTmpCatalog({
    name: "Test",
    version: "1",
    plugins: [
      { name: "reddit.search", version: "0.1.0", manifestUrl: "https://x/manifest.json" },
    ],
  });
  const prevUrl  = process.env.PLUGIN_CATALOG_URL;
  const prevFile = process.env.PLUGIN_CATALOG_FILE;
  delete process.env.PLUGIN_CATALOG_URL;
  process.env.PLUGIN_CATALOG_FILE = f;
  try {
    const r = await loadCatalog({ refresh: true });
    assert.equal(r.data.name, "Test");
    assert.equal(r.data.plugins.length, 1);
    assert.equal(r.data.plugins[0].name, "reddit.search");
    assert.equal(r.source, f);
  } finally {
    if (prevUrl)  process.env.PLUGIN_CATALOG_URL  = prevUrl;
    if (prevFile) process.env.PLUGIN_CATALOG_FILE = prevFile;
    else delete process.env.PLUGIN_CATALOG_FILE;
  }
});

test("loadCatalog: rejects a catalog whose plugins[] is missing required fields", async () => {
  const f = writeTmpCatalog({
    name: "Test",
    version: "1",
    plugins: [{ name: "reddit.search" }],   // missing version + manifestUrl
  });
  const prev = process.env.PLUGIN_CATALOG_FILE;
  delete process.env.PLUGIN_CATALOG_URL;
  process.env.PLUGIN_CATALOG_FILE = f;
  try {
    await assert.rejects(
      () => loadCatalog({ refresh: true }),
      /missing/,
    );
  } finally {
    if (prev) process.env.PLUGIN_CATALOG_FILE = prev;
    else delete process.env.PLUGIN_CATALOG_FILE;
  }
});

test("loadCatalog: rejects non-JSON file with a clear message", async () => {
  const f = writeTmpCatalog("this is not json {{{");
  const prev = process.env.PLUGIN_CATALOG_FILE;
  delete process.env.PLUGIN_CATALOG_URL;
  process.env.PLUGIN_CATALOG_FILE = f;
  try {
    await assert.rejects(
      () => loadCatalog({ refresh: true }),
      /not JSON/,
    );
  } finally {
    if (prev) process.env.PLUGIN_CATALOG_FILE = prev;
    else delete process.env.PLUGIN_CATALOG_FILE;
  }
});
