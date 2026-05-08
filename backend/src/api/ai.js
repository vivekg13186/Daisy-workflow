// "Ask AI" assistant — proxies chat completions to Anthropic or any
// OpenAI-compatible API. The system prompt is built from the live plugin
// registry so the model always sees the current actions + their schemas.
//
// Endpoints:
//   GET  /ai/status        → { configured, provider, model }
//   POST /ai/chat          → body: { messages: [{role, content}] }
//                            res:  { message: { role: "assistant", content } }

import { Router } from "express";
import { config } from "../config.js";
import { registry } from "../plugins/registry.js";
import { ValidationError, HttpError } from "../utils/errors.js";

const router = Router();

router.get("/status", (_req, res) => {
  const k = config.ai.apiKey;
  const expectedPrefix = config.ai.provider === "anthropic" ? "sk-ant-" : "sk-";
  const warnings = [];

  if (k && k.length !== config.ai.rawKeyLen) {
    warnings.push(`stripped ${config.ai.rawKeyLen - k.length} whitespace/quote char(s) from the env value`);
  }
  if (k && !k.startsWith(expectedPrefix)) {
    warnings.push(`provider=${config.ai.provider} but key does not start with "${expectedPrefix}"`);
  }
  if (k && k.length < 20) {
    warnings.push(`key looks too short (${k.length} chars)`);
  }

  res.json({
    configured: Boolean(k),
    provider:   config.ai.provider,
    model:      config.ai.model,
    baseUrl:    config.ai.baseUrl,
    keyPreview: k ? `${k.slice(0, 8)}…${k.slice(-4)} (${k.length} chars)` : null,
    warnings,
  });
});

router.post("/chat", async (req, res, next) => {
  try {
    const { messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new ValidationError("`messages` array required");
    }
    if (!config.ai.apiKey) {
      throw new HttpError(503, "AI_NOT_CONFIGURED",
        "AI is not configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY in the backend env.");
    }

    // Sanitize: only keep recognized roles + string content.
    const cleanMessages = messages
      .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-20); // cap conversation length to keep prompts small
    if (cleanMessages.length === 0) throw new ValidationError("no valid messages");

    const system = buildSystemPrompt();
    const text = await callLlm(system, cleanMessages);
    res.json({ message: { role: "assistant", content: text } });
  } catch (e) { next(e); }
});

// ---------- prompt building ----------

function buildSystemPrompt() {
  const plugins = registry.list();
  const pluginDocs = plugins.map(p => {
    const inputProps = listProps(p.inputSchema);
    const outputProps = listProps(p.outputSchema);
    return `### ${p.name}
${p.description || "(no description)"}
Inputs: ${inputProps || "(none)"}
Outputs: ${outputProps || "(none)"}`;
  }).join("\n\n");

  return `You are an AI assistant for the **DAG Workflow Engine** — a YAML-driven DAG runner with pluggable actions. Help the user understand the DSL, choose plugins, and write workflow snippets.

# DSL reference

\`\`\`yaml
name: <flow name>
description: <free text>     # optional
data:                        # global constants merged into the root context
  someKey: someValue

nodes:
  - name: <unique node name>
    action: <plugin id from the list below>
    description: <optional>
    inputs:                  # object form, OR array of single-key maps:
      key1: "expr"           #   - key1: "expr"
      key2: ${'${var}'}      #   - key2: ${'${var}'}
    outputs:                 # map plugin output fields onto root ctx vars:
      pluginField: ctxVar    #   ctxVar = pluginOutput.pluginField  (dot paths OK)
    executeIf: ${'${expr}'}   # skip this node if false; downstream still runs
    retry: 3                 # default 0
    retryDelay: "500ms"      # number of ms or duration string
    onError: continue|terminate    # default terminate
    batchOver: ${'${array}'}  # fan out: run once per item; ${'${item}'}, ${'${index}'} available

edges:
  - { from: <nodeName>, to: <nodeName> }
\`\`\`

## Expression rules
- ${'${url}'} resolves from the root context (data block or run input).
- ${'${nodes.<nodeName>.output.<path>}'} reads a previous node's output (full plugin output, not the mapped ctxVar).
- Comparisons & arithmetic via expr-eval are supported, e.g. ${'${count > 0}'}.

## Run-time context shape
Root keys = parsed.data merged with user-provided JSON input from the Run dialog. Plus:
- nodes.<name>.{status,output,startedAt,finishedAt,attempts}
- For batch nodes inside batchOver: ${'${item}'} and ${'${index}'}.

# Available action plugins

${pluginDocs}

# Output guidelines

- When you generate a workflow, output it inside a fenced \`\`\`yaml block — the UI offers a "Use this YAML" button on those blocks.
- Reference only plugins listed above; if the user asks for something not covered, suggest the closest plugin or say it doesn't exist.
- Keep prose answers short; lead with the example.
- Always set \`name\` and at least one node + (if multiple nodes) at least one edge. Do NOT include a \`version\` field — the server tracks versions automatically.`;
}

function listProps(schema) {
  if (!schema || !schema.properties) return "";
  const required = new Set(schema.required || []);
  return Object.entries(schema.properties)
    .map(([k, v]) => {
      const req = required.has(k) ? "*" : "";
      const t = v?.type || (v?.enum ? `enum(${v.enum.join("|")})` : "any");
      return `${k}${req}: ${t}`;
    })
    .join(", ");
}

// ---------- providers ----------

async function callLlm(system, messages) {
  if (config.ai.provider === "anthropic") return callAnthropic(system, messages);
  return callOpenAI(system, messages);
}

async function callOpenAI(system, messages) {
  const url = `${config.ai.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${config.ai.apiKey}`,
    },
    body: JSON.stringify({
      model: config.ai.model,
      messages: [{ role: "system", content: system }, ...messages],
      max_tokens: config.ai.maxTokens,
      temperature: 0.3,
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new HttpError(res.status, "AI_ERROR", `OpenAI: ${res.status} ${txt.slice(0, 500)}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || "";
}

async function callAnthropic(system, messages) {
  const url = `${config.ai.baseUrl.replace(/\/$/, "")}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.ai.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.ai.model,
      max_tokens: config.ai.maxTokens,
      system,
      messages,
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    let hint = "";
    if (res.status === 401) {
      const k = config.ai.apiKey;
      const masked = k ? `${k.slice(0, 8)}…${k.slice(-4)} (${k.length} chars)` : "(none)";
      const prefixWrong = k && !k.startsWith("sk-ant-");
      hint = ` — server received key ${masked}.` +
        (prefixWrong ? " The key does not start with sk-ant-, which Anthropic requires." : "") +
        " Common causes: trailing whitespace in .env, wrong key copied (OpenAI vs Anthropic), or revoked key. Check GET /ai/status for warnings.";
    }
    throw new HttpError(res.status, "AI_ERROR", `Anthropic: ${res.status} ${txt.slice(0, 500)}${hint}`);
  }
  const data = await res.json();
  // Anthropic returns content as an array of blocks; concatenate text blocks.
  const blocks = Array.isArray(data?.content) ? data.content : [];
  return blocks.filter(b => b.type === "text").map(b => b.text).join("");
}

export default router;
