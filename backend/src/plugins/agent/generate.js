// Plugin-generator agent.
//
// One-shot LLM call that turns a free-form user prompt
// ("a plugin that translates text using DeepL") into a
// complete HTTP-transport plugin scaffold: manifest, index.js,
// package.json, Dockerfile, README, and a deploy section the
// admin Plugins page renders verbatim.
//
// The agent doesn't run the plugin or install it — it just
// emits files. Persisting/installing remains a deliberate admin
// step (POST /plugins/install), so a hallucinated plugin can't
// silently land in the registry.
//
// Output shape (strict JSON returned by the model):
//
//   {
//     "name":        "deepl.translate",
//     "version":     "0.1.0",
//     "summary":     "Translate text using the DeepL Pro API.",
//     "files": [
//       { "path": "manifest.json",  "content": "{...}" },
//       { "path": "index.js",       "content": "..."  },
//       { "path": "package.json",   "content": "..."  },
//       { "path": "Dockerfile",     "content": "..."  },
//       { "path": "README.md",      "content": "..."  }
//     ],
//     "deployInstructions": "<markdown>"
//   }

import { config } from "../../config.js";
import { HttpError } from "../../utils/errors.js";
import { log } from "../../utils/logger.js";

const SYSTEM_PROMPT = `\
You are a code-generator for plugins of the Daisy-DAG workflow engine.

You produce ONLY a single, strict JSON object. No prose before or after, no markdown
fences. The shape is:

{
  "name":     "<dotted.identifier>",        // matches /^[a-z][a-z0-9_.-]*$/
  "version":  "0.1.0",                       // semver (default 0.1.0 for new plugins)
  "summary":  "<one line description>",
  "files": [
    { "path": "manifest.json", "content": "<file body as a string>" },
    { "path": "index.js",      "content": "..." },
    { "path": "package.json",  "content": "..." },
    { "path": "Dockerfile",    "content": "..." },
    { "path": "README.md",     "content": "..." }
  ],
  "deployInstructions": "<markdown showing build + run + install steps>"
}

CRITICAL RULES:

1. The plugin uses HTTP transport via daisy-plugin-sdk. index.js MUST be:

   import { servePlugin } from "daisy-plugin-sdk";
   import fs from "node:fs";

   const manifest = JSON.parse(
     fs.readFileSync(new URL("./manifest.json", import.meta.url), "utf8"),
   );

   servePlugin({
     manifest,
     async execute(input, ctx) {
       // ctx = { executionId, workspaceId, nodeName, config, deadlineMs, signal }
       // Real work here. Honour ctx.signal on long-running fetches.
       return { /* output matching outputSchema */ };
     },
     async readyz() { return true; },
   });

2. manifest.json MUST declare: name, version, description, primaryOutput,
   inputSchema, outputSchema. Optionally: configRefs (list of { name, type, required }).
   The inputSchema MUST be a valid JSON Schema object with type=object and
   "required" listing every mandatory input.

3. package.json MUST be type=module, depend on "daisy-plugin-sdk" (the
   published npm package — pin to a caret range like "^0.1.0"), and
   declare a "start" script of "node index.js". Include any third-party
   deps the plugin actually uses.

4. Dockerfile MUST use node:22-alpine, COPY the plugin folder into
   /workspace, set WORKDIR to /workspace, run "npm install --omit=dev"
   (which pulls daisy-plugin-sdk from npm), drop privileges with
   "USER node", and end with CMD ["node", "index.js"]. The image is
   self-contained — no repo-root context is needed because the SDK is
   on npm.

5. README.md briefly explains what the plugin does, the input/output shape,
   and any required workspace configs (configRefs).

6. deployInstructions is a markdown string with three numbered steps:
   (a) "save the files into any folder",
   (b) "docker build -t <name>-plugin . && docker run -d --name <name>-plugin -p 8080:8080 <name>-plugin",
   (c) install with "POST /plugins/install { endpoint: 'http://<name>-plugin:8080' }"
   or via the Plugins page "Install from URL" button.

7. If the plugin needs secrets (API keys), declare them via configRefs in
   manifest.json — DO NOT prompt the user for env vars. The engine will
   inject them into ctx.config at execute time.

8. Plugin name format: "<vendor>.<verb>" (e.g. "deepl.translate", "slack.send").
   Use lowercase, dots and hyphens only.

Return ONLY the JSON object. No commentary.
`;

/**
 * Generate a plugin scaffold from a free-form prompt.
 *
 *   generatePlugin({ prompt, transport })
 *     prompt    — user's request (required)
 *     transport — "http" (default). "in-process" reserved for future use.
 *
 * Throws HttpError(503) if AI isn't configured, (502) on upstream errors,
 * (422) if the model's response can't be parsed into the expected shape.
 */
export async function generatePlugin({ prompt, transport = "http" }) {
  if (!prompt || typeof prompt !== "string" || prompt.trim().length < 5) {
    throw new HttpError(400, "BAD_PROMPT", "prompt must be a non-empty string of at least 5 chars");
  }
  if (transport !== "http") {
    throw new HttpError(400, "UNSUPPORTED_TRANSPORT",
      "only http transport is supported by the generator today");
  }
  if (!config.ai.apiKey) {
    throw new HttpError(503, "AI_NOT_CONFIGURED",
      "AI is not configured on this server — set ANTHROPIC_API_KEY or OPENAI_API_KEY in .env");
  }

  const user = `User request:\n${prompt.trim()}\n\nGenerate the plugin scaffold now.`;

  log.info("plugin agent: generating scaffold", {
    provider: config.ai.provider, model: config.ai.model, promptLen: prompt.length,
  });

  const raw = await callLlmJson(SYSTEM_PROMPT, user);
  const parsed = extractJson(raw);
  validateGenerated(parsed);
  return parsed;
}

// ────────────────────────────────────────────────────────────────────
// Provider-agnostic call. We don't go through ai.js's plain helpers
// because we want a slightly tighter system prompt + a higher max_tokens
// budget than the chat path uses.
// ────────────────────────────────────────────────────────────────────

async function callLlmJson(system, userText) {
  const isAnthropic = config.ai.provider === "anthropic";
  const url = isAnthropic
    ? `${config.ai.baseUrl.replace(/\/$/, "")}/messages`
    : `${config.ai.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const headers = isAnthropic
    ? {
        "content-type":      "application/json",
        "x-api-key":         config.ai.apiKey,
        "anthropic-version": "2023-06-01",
      }
    : {
        "content-type":  "application/json",
        "authorization": `Bearer ${config.ai.apiKey}`,
      };
  const body = isAnthropic
    ? {
        model: config.ai.model,
        max_tokens: Math.max(config.ai.maxTokens || 4096, 4096),
        system,
        messages: [{ role: "user", content: userText }],
      }
    : {
        model: config.ai.model,
        max_tokens: Math.max(config.ai.maxTokens || 4096, 4096),
        temperature: 0.2,
        // Strict JSON if the provider supports it; harmless otherwise.
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user",   content: userText },
        ],
      };

  const r = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new HttpError(502, "AI_UPSTREAM_ERROR",
      `${config.ai.provider} returned ${r.status}: ${txt.slice(0, 400)}`);
  }
  const data = await r.json();
  if (isAnthropic) {
    const blocks = Array.isArray(data?.content) ? data.content : [];
    return blocks.filter(b => b.type === "text").map(b => b.text).join("");
  }
  return data?.choices?.[0]?.message?.content || "";
}

// ────────────────────────────────────────────────────────────────────
// Robust JSON extraction. The model is told to return strict JSON,
// but sometimes wraps it in ```json fences or adds a trailing sentence.
// We strip fences and find the outermost {...} block.
// ────────────────────────────────────────────────────────────────────

function extractJson(s) {
  if (!s || typeof s !== "string") {
    throw new HttpError(422, "AI_EMPTY", "agent returned no content");
  }
  let t = s.trim();
  // Strip ```json ... ``` or ``` ... ``` fences.
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) t = fence[1].trim();
  // Heuristic: find first { ... matching } at the outermost level.
  if (!t.startsWith("{")) {
    const first = t.indexOf("{");
    const last  = t.lastIndexOf("}");
    if (first < 0 || last <= first) {
      throw new HttpError(422, "AI_NOT_JSON", "agent response is not JSON");
    }
    t = t.slice(first, last + 1);
  }
  try {
    return JSON.parse(t);
  } catch (e) {
    throw new HttpError(422, "AI_BAD_JSON", `agent JSON parse failed: ${e.message}`);
  }
}

// ────────────────────────────────────────────────────────────────────
// Sanity-check the generated bundle so we surface a clear error
// instead of letting the frontend render garbage.
// ────────────────────────────────────────────────────────────────────

function validateGenerated(g) {
  if (!g || typeof g !== "object") {
    throw new HttpError(422, "AI_BAD_SHAPE", "agent output is not an object");
  }
  if (typeof g.name !== "string" || !/^[a-z][a-z0-9_.-]*$/.test(g.name)) {
    throw new HttpError(422, "AI_BAD_NAME",
      `agent picked a bad plugin name "${g.name}" (must match /^[a-z][a-z0-9_.-]*$/)`);
  }
  if (typeof g.version !== "string" || !/^\d+\.\d+\.\d+/.test(g.version)) {
    throw new HttpError(422, "AI_BAD_VERSION",
      `agent picked a bad version "${g.version}" (must be semver)`);
  }
  if (!Array.isArray(g.files) || g.files.length === 0) {
    throw new HttpError(422, "AI_NO_FILES", "agent did not emit any files");
  }
  const seen = new Set();
  const requiredPaths = ["manifest.json", "index.js", "package.json", "Dockerfile"];
  for (const f of g.files) {
    if (!f || typeof f.path !== "string" || typeof f.content !== "string") {
      throw new HttpError(422, "AI_BAD_FILE", "every file must be { path, content } strings");
    }
    if (f.path.includes("..") || f.path.startsWith("/")) {
      throw new HttpError(422, "AI_BAD_PATH",
        `agent tried to write outside the plugin folder: "${f.path}"`);
    }
    seen.add(f.path);
  }
  for (const p of requiredPaths) {
    if (!seen.has(p)) {
      throw new HttpError(422, "AI_MISSING_FILE",
        `agent forgot to emit "${p}" — required for an HTTP-transport plugin`);
    }
  }
  // Manifest must round-trip as JSON.
  const m = g.files.find(f => f.path === "manifest.json");
  try { JSON.parse(m.content); }
  catch (e) {
    throw new HttpError(422, "AI_BAD_MANIFEST", `manifest.json is not valid JSON: ${e.message}`);
  }
  if (typeof g.deployInstructions !== "string" || g.deployInstructions.length < 10) {
    // Don't fail hard — render a stub so the user still gets something.
    g.deployInstructions = `1. Save these files under \`plugins-external/${g.name}/\`.\n` +
      "2. Build and run with docker compose.\n" +
      "3. Install from the Plugins page → Install from URL.";
  }
  return g;
}
