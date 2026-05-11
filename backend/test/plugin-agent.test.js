// Plugin agent — covers the JSON-extraction + scaffold-validation
// path that protects the UI from a model that hallucinates a bad
// shape.
//
//   npm test
//
// Like the other plugin tests we stub the DB pool (the agent doesn't
// touch it but the import graph drags in audit/logger) and the
// global fetch (the agent's whole job is to call the LLM endpoint).

import { test, mock } from "node:test";
import assert from "node:assert/strict";

// AI must look "configured" to generate.js — set the env var that
// config.js reads before the module is imported.
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "sk-ant-test-fake";
process.env.AI_PROVIDER       = "anthropic";

mock.module("../src/db/pool.js", {
  namedExports: { pool: { async query() { return { rows: [], rowCount: 0 }; } } },
});

const { generatePlugin } = await import("../src/plugins/agent/generate.js");

function withFetchMock(fakeFetch) {
  const original = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  return () => { globalThis.fetch = original; };
}

// Build an Anthropic-shaped response wrapping the given assistant text.
function anthropicResp(text) {
  return new Response(JSON.stringify({
    content: [{ type: "text", text }],
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function validScaffold() {
  return {
    name:    "deepl.translate",
    version: "0.1.0",
    summary: "Translate text using DeepL.",
    files: [
      { path: "manifest.json", content: JSON.stringify({
        name: "deepl.translate", version: "0.1.0", description: "x",
        primaryOutput: "translated",
        inputSchema:  { type: "object", required: ["text"], properties: { text: { type: "string" } } },
        outputSchema: { type: "object", properties: { translated: { type: "string" } } },
      }) },
      { path: "index.js",     content: "// stub" },
      { path: "package.json", content: "{}" },
      { path: "Dockerfile",   content: "FROM node:22-alpine" },
      { path: "README.md",    content: "stub" },
    ],
    deployInstructions: "1. unzip\n2. docker compose up\n3. install from URL",
  };
}

// ────────────────────────────────────────────────────────────────────
// Input validation
// ────────────────────────────────────────────────────────────────────

test("generatePlugin: rejects empty / too-short prompt", async () => {
  await assert.rejects(() => generatePlugin({ prompt: "" }),    /prompt must be/);
  await assert.rejects(() => generatePlugin({ prompt: "hi" }),  /prompt must be/);
});

test("generatePlugin: rejects unsupported transport", async () => {
  await assert.rejects(
    () => generatePlugin({ prompt: "anything goes here", transport: "grpc" }),
    /only http transport/,
  );
});

// ────────────────────────────────────────────────────────────────────
// Happy path — strict JSON response
// ────────────────────────────────────────────────────────────────────

test("generatePlugin: parses strict JSON output verbatim", async () => {
  const scaffold = validScaffold();
  const restore = withFetchMock(async () => anthropicResp(JSON.stringify(scaffold)));
  try {
    const r = await generatePlugin({ prompt: "translate with deepl please" });
    assert.equal(r.name,    "deepl.translate");
    assert.equal(r.version, "0.1.0");
    assert.equal(r.files.length, 5);
    assert.ok(r.deployInstructions.length > 0);
  } finally { restore(); }
});

test("generatePlugin: strips ```json fences", async () => {
  const scaffold = validScaffold();
  const fenced = "```json\n" + JSON.stringify(scaffold) + "\n```";
  const restore = withFetchMock(async () => anthropicResp(fenced));
  try {
    const r = await generatePlugin({ prompt: "deepl translate" });
    assert.equal(r.name, "deepl.translate");
  } finally { restore(); }
});

test("generatePlugin: tolerates trailing prose", async () => {
  const scaffold = validScaffold();
  const noisy = "Sure, here you go:\n" + JSON.stringify(scaffold) + "\nLet me know!";
  const restore = withFetchMock(async () => anthropicResp(noisy));
  try {
    const r = await generatePlugin({ prompt: "deepl translate" });
    assert.equal(r.files.length, 5);
  } finally { restore(); }
});

// ────────────────────────────────────────────────────────────────────
// Validation errors surface as 422s
// ────────────────────────────────────────────────────────────────────

test("generatePlugin: rejects invalid plugin name", async () => {
  const bad = { ...validScaffold(), name: "Bad Name!" };
  const restore = withFetchMock(async () => anthropicResp(JSON.stringify(bad)));
  try {
    await assert.rejects(
      () => generatePlugin({ prompt: "some plugin idea" }),
      /bad plugin name/,
    );
  } finally { restore(); }
});

test("generatePlugin: rejects non-semver version", async () => {
  const bad = { ...validScaffold(), version: "latest" };
  const restore = withFetchMock(async () => anthropicResp(JSON.stringify(bad)));
  try {
    await assert.rejects(
      () => generatePlugin({ prompt: "some plugin" }),
      /bad version/,
    );
  } finally { restore(); }
});

test("generatePlugin: rejects when a required file is missing", async () => {
  const bad = validScaffold();
  bad.files = bad.files.filter(f => f.path !== "Dockerfile");
  const restore = withFetchMock(async () => anthropicResp(JSON.stringify(bad)));
  try {
    await assert.rejects(
      () => generatePlugin({ prompt: "some plugin" }),
      /Dockerfile/,
    );
  } finally { restore(); }
});

test("generatePlugin: rejects path traversal attempts", async () => {
  const bad = validScaffold();
  bad.files.push({ path: "../../etc/passwd", content: "evil" });
  const restore = withFetchMock(async () => anthropicResp(JSON.stringify(bad)));
  try {
    await assert.rejects(
      () => generatePlugin({ prompt: "some plugin" }),
      /outside the plugin folder/,
    );
  } finally { restore(); }
});

test("generatePlugin: rejects absolute paths", async () => {
  const bad = validScaffold();
  bad.files.push({ path: "/etc/passwd", content: "evil" });
  const restore = withFetchMock(async () => anthropicResp(JSON.stringify(bad)));
  try {
    await assert.rejects(
      () => generatePlugin({ prompt: "some plugin" }),
      /outside the plugin folder/,
    );
  } finally { restore(); }
});

test("generatePlugin: rejects when manifest.json is not valid JSON", async () => {
  const bad = validScaffold();
  bad.files = bad.files.map(f => f.path === "manifest.json"
    ? { ...f, content: "{ not json" }
    : f
  );
  const restore = withFetchMock(async () => anthropicResp(JSON.stringify(bad)));
  try {
    await assert.rejects(
      () => generatePlugin({ prompt: "some plugin" }),
      /manifest\.json is not valid JSON/,
    );
  } finally { restore(); }
});

test("generatePlugin: substitutes a stub when deployInstructions is missing", async () => {
  const bad = { ...validScaffold(), deployInstructions: "" };
  const restore = withFetchMock(async () => anthropicResp(JSON.stringify(bad)));
  try {
    const r = await generatePlugin({ prompt: "some plugin" });
    assert.ok(r.deployInstructions.length > 10);
    assert.match(r.deployInstructions, /plugins-external/);
  } finally { restore(); }
});

// ────────────────────────────────────────────────────────────────────
// Upstream errors
// ────────────────────────────────────────────────────────────────────

test("generatePlugin: surfaces 502 when the LLM provider errors", async () => {
  const restore = withFetchMock(async () => new Response("Rate limited", { status: 429 }));
  try {
    await assert.rejects(
      () => generatePlugin({ prompt: "some plugin" }),
      /returned 429/,
    );
  } finally { restore(); }
});

test("generatePlugin: surfaces 422 when the LLM returns no content", async () => {
  const restore = withFetchMock(async () => anthropicResp(""));
  try {
    await assert.rejects(
      () => generatePlugin({ prompt: "some plugin" }),
      /no content/,
    );
  } finally { restore(); }
});
