// "Ask AI" assistant — proxies chat completions to Anthropic or any
// OpenAI-compatible API. The system prompt is built from the live plugin
// registry so the model always sees the current actions + their schemas.
//
// Endpoints:
//   GET  /ai/status        → { configured, provider, model }
//   POST /ai/chat          → body: { messages: [{role, content}] }
//                            res:  { message: { role: "assistant", content } }
//
//   POST /ai/agent/chat    → body: { messages, graphId?, currentGraph? }
//                            res:  {
//                              message: { role: "assistant", content },
//                              proposedGraph?: <DSL object>,           // set when update_graph fired
//                              triggerCreated?: { id, name, type },    // set when create_trigger fired
//                              traces: [{ tool, input, summary }],     // ordered tool calls
//                            }
//
// The agent endpoint runs a tool-use loop with four tools:
//   • get_current_graph()           → returns the working draft the editor sent
//   • update_graph(dsl)             → validates DSL; the new shape is returned
//                                     in `proposedGraph` for the editor to apply
//   • list_triggers()               → triggers attached to graphId (or all)
//   • create_trigger({name,type,config}) → INSERT into triggers; refuses if the
//                                     graph hasn't been saved yet (no graphId)
//   • list_configs()                → name + type for every stored configuration

import { Router } from "express";
import { v4 as uuid } from "uuid";
import { config } from "../config.js";
import { registry } from "../plugins/registry.js";
import { parseDag } from "../dsl/parser.js";
import { pool } from "../db/pool.js";
import { triggerRegistry } from "../triggers/registry.js";
import { syncTrigger } from "../triggers/manager.js";
import { ValidationError, HttpError } from "../utils/errors.js";
import { requireUser, requireRole } from "../middleware/auth.js";

const router = Router();

// All AI endpoints require an authenticated caller. The "Ask AI"
// helper writes to triggers / proposes graphs scoped to the caller's
// workspace, so the caller's role and workspace_id flow through into
// each tool implementation via the `ctx` object passed to runAgentLoop.
router.use(requireUser);

router.get("/status", requireRole("admin", "editor", "viewer"), (_req, res) => {
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

// ──────────────────────────────────────────────────────────────────────
// /chat — the legacy single-shot endpoint. Still wired up so older clients
// (and the JSON-tab "Ask AI" button) keep working.
// ──────────────────────────────────────────────────────────────────────
router.post("/chat", requireRole("admin", "editor"), async (req, res, next) => {
  try {
    const { messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new ValidationError("`messages` array required");
    }
    if (!config.ai.apiKey) {
      throw new HttpError(503, "AI_NOT_CONFIGURED",
        "AI is not configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY in the backend env.");
    }

    const cleanMessages = messages
      .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-20);
    if (cleanMessages.length === 0) throw new ValidationError("no valid messages");

    const system = buildSystemPrompt({ agentMode: false });
    const text = await callPlainLlm(system, cleanMessages);
    res.json({ message: { role: "assistant", content: text } });
  } catch (e) { next(e); }
});

// ──────────────────────────────────────────────────────────────────────
// /agent/chat — tool-use loop. Each call returns the assistant's final
// text reply plus any side-effects that fired during the loop (proposed
// graph, created trigger, ordered trace of every tool call).
// ──────────────────────────────────────────────────────────────────────
router.post("/agent/chat", requireRole("admin", "editor"), async (req, res, next) => {
  try {
    const { messages, graphId, currentGraph } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new ValidationError("`messages` array required");
    }
    if (!config.ai.apiKey) {
      throw new HttpError(503, "AI_NOT_CONFIGURED",
        "AI is not configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY in the backend env.");
    }

    const cleanMessages = messages
      .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-30);
    if (cleanMessages.length === 0) throw new ValidationError("no valid messages");

    const ctx = {
      graphId:        graphId || null,
      currentGraph:   currentGraph || null,    // mutated by update_graph
      proposedGraph:  null,
      triggerCreated: null,
      traces:         [],
      // Workspace surface so list_triggers / list_configs / create_trigger
      // are scoped to the caller. Without this the AI agent could see /
      // create resources across workspace boundaries.
      workspaceId:    req.user.workspaceId,
      role:           req.user.role,
      // Forwarded into create_trigger so the resulting row carries
      // the caller as its updated_by for audit.
      userId:         req.user.id,
    };

    const system = buildSystemPrompt({ agentMode: true, ctx });
    const finalText = await runAgentLoop({ system, messages: cleanMessages, ctx });

    res.json({
      message:        { role: "assistant", content: finalText },
      proposedGraph:  ctx.proposedGraph,
      triggerCreated: ctx.triggerCreated,
      traces:         ctx.traces,
    });
  } catch (e) { next(e); }
});

// ---------- system prompt ----------

function buildSystemPrompt({ agentMode = false, ctx = null } = {}) {
  const plugins = registry.list();
  const pluginDocs = plugins.map(p => {
    const inputProps  = listProps(p.inputSchema);
    const outputProps = listProps(p.outputSchema);
    return `### ${p.name}
${p.description || "(no description)"}
Inputs: ${inputProps || "(none)"}
Outputs: ${outputProps || "(none)"}${p.primaryOutput ? `
primaryOutput: ${p.primaryOutput}` : ""}`;
  }).join("\n\n");

  const triggerDocs = triggerRegistry.list().map(t => {
    const cs = listProps(t.configSchema);
    return `### trigger:${t.type}
${t.description || ""}
Config: ${cs || "(none)"}`;
  }).join("\n\n");

  const dslRef = `# DSL reference (JSON)

\`\`\`json
{
  "name": "<flow name>",
  "description": "<free text>",
  "data": { "someKey": "someValue" },
  "nodes": [
    {
      "name": "<unique node name>",
      "action": "<plugin id>",
      "description": "<optional>",
      "inputs":     { "key1": "literal", "key2": "\${var}" },
      "outputs":    { "pluginField": "ctxVar" },
      "executeIf":  "\${expr}",
      "retry":      3,
      "retryDelay": "500ms",
      "onError":    "terminate",
      "batchOver":  "\${array}",
      "outputVar":  "<ctx var name>"
    }
  ],
  "edges": [ { "from": "<nodeName>", "to": "<nodeName>" } ]
}
\`\`\`

Field notes:
- \`description\` is optional everywhere.
- \`inputs\` is a flat object — keys are plugin input names, values are literals or \${expr} references.
- \`outputs\` maps plugin output paths (dot paths OK, e.g. "body.id") to ctx variable names.
- \`executeIf\` skips a node when false; descendants reachable only through it cascade to skipped.
- \`retry\` defaults to 0; \`retryDelay\` accepts ms or "500ms"/"2s" duration strings.
- \`onError\` is "terminate" (default) or "continue".
- \`batchOver\` fans out: runs once per item; \${item} and \${index} are exposed.
- \`outputVar\`: the engine writes the plugin's primary output to ctx[outputVar] after each run.
- Do NOT include a \`version\` field — it is no longer part of the schema.

## Expression rules
- \${url} resolves from data block + run input.
- \${nodes.<nodeName>.output.<path>} reads a previous node's full output.
- Expressions are FEEL (Friendly Enough Expression Language). Comparison is \`=\` (not \`==\`); logical ops are \`and\` / \`or\` / \`not\`. JS-style \`==\` / \`&&\` / \`||\` are translated automatically for back-compat.
- \`config.<configName>.<field>\` reads a stored configuration's field.

# Available action plugins

${pluginDocs}

# Available trigger types

${triggerDocs}`;

  if (!agentMode) {
    return `You are an AI assistant for the **DAG Workflow Engine** — a JSON-driven DAG runner. Help the user understand the DSL, choose plugins, and write workflow snippets.

${dslRef}

# Output guidelines
- When you generate a workflow, output it inside a fenced \`\`\`json block — the UI offers a "Use this JSON" button.
- Reference only plugins listed above.
- Keep prose answers short; lead with the example.`;
  }

  // Agent-mode prompt
  const ctxBlurb = ctx?.currentGraph
    ? `The user is currently editing a workflow named "${ctx.currentGraph.name || "(unnamed)"}" with ${ctx.currentGraph.nodes?.length || 0} node(s)${ctx.graphId ? ` (saved as id ${ctx.graphId})` : " (not yet saved)"}.`
    : `No workflow is loaded yet — the user is on a blank canvas.`;

  return `You are the **AI Workflow Designer** for the DAG Engine. The user describes what they want; you build it.

${ctxBlurb}

# How you work

You drive the editor through tools:
- **get_current_graph** — read what's already on the canvas before changing it.
- **update_graph** — replace the working draft with a new DSL. The user must still click Save afterwards; never describe a workflow as "saved".
- **list_configs** — see existing stored configurations (database / mail.smtp / mqtt / etc). Reference them by name in plugin inputs (\`"config": "<name>"\`); never invent a config name.
- **list_triggers** — check existing triggers attached to this workflow before proposing a new one.
- **create_trigger** — only after the workflow is saved (it needs a graphId). If the user wants a trigger and the workflow isn't saved yet, tell them to save first.

# Conversation rules

1. **Ask before guessing.** If the request is ambiguous (which config? which schedule? which fields to extract from a page?), ask one focused question before calling any tool.
2. **Iterate, don't restart.** When the user says "add X" or "tweak Y", call \`get_current_graph\` first and emit a complete-but-minimally-changed graph through \`update_graph\`.
3. **Explain what you did.** After tool calls, briefly summarise what changed ("Added a delay node before the http.request, retrying twice on failure"). Don't paste the full JSON unless the user asks.
4. **Triggers.** Before \`create_trigger\`, call \`list_triggers\` and offer to reuse an existing one if the type/config matches the user's intent. After creating, mention the trigger's name and that it's now active.
5. **Configs.** Don't invent secret values. If the user wants to email/MQTT/SQL through credentials that don't exist as a stored config yet, call \`list_configs\` to confirm and tell them to add one through Home → Configurations (you can't create configs).
6. **DSL correctness.** Every \`update_graph\` call must produce a graph that validates: unique node names matching \`^[A-Za-z_][A-Za-z0-9_.-]*$\`, every edge endpoint references an existing node, no cycles, plugin inputs match the schemas above. The server validates and you'll get an error back if it fails — fix and retry.

${dslRef}

# Style

- Concise. Bullet a change list when it's complex; otherwise one short paragraph.
- Quote node / trigger / config names in backticks.
- Don't restate the user's request before answering.`;
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

// ──────────────────────────────────────────────────────────────────────
// Tool registry — definitions + handlers shared by both providers.
// ──────────────────────────────────────────────────────────────────────

const TOOL_DEFS = [
  {
    name: "get_current_graph",
    description:
      "Read the working draft of the workflow currently open in the editor. " +
      "Returns the DSL object (or null if the canvas is empty). " +
      "Always call this before modifying — the user may have edited the canvas since the last update_graph.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "update_graph",
    description:
      "Replace the editor's working draft with a new DSL. The DSL is validated " +
      "server-side; an invalid DSL returns an `errors` list and the editor is NOT touched. " +
      "The user must still click Save in the toolbar to persist.",
    input_schema: {
      type: "object",
      required: ["dsl"],
      properties: {
        dsl: {
          type: "object",
          description:
            "Full DAG DSL. Must include `name` and a non-empty `nodes` array. Do NOT include a `version` field.",
        },
      },
    },
  },
  {
    name: "list_triggers",
    description:
      "List triggers attached to the currently-open workflow (or all triggers, " +
      "if the workflow hasn't been saved yet). Each result includes id, name, type, config, enabled.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "create_trigger",
    description:
      "Create a new trigger that fires the currently-open workflow. " +
      "Requires the workflow to be saved already (graphId must be present). " +
      "type must be one of the available trigger types (schedule / webhook / email / mqtt). " +
      "config must validate against that type's schema.",
    input_schema: {
      type: "object",
      required: ["name", "type", "config"],
      properties: {
        name:   { type: "string", description: "Display name for the trigger." },
        type:   { type: "string", description: "Trigger type id (schedule / webhook / email / mqtt)." },
        config: { type: "object", description: "Driver-specific configuration." },
      },
    },
  },
  {
    name: "list_configs",
    description:
      "List existing stored configurations (database / mail.smtp / mail.imap / mqtt / generic) by name + type. " +
      "Use this to verify a config name exists before referencing it from plugin inputs. Secret fields are NOT returned.",
    input_schema: { type: "object", properties: {} },
  },
];

async function runTool(name, input, ctx) {
  switch (name) {
    case "get_current_graph": return toolGetCurrentGraph(ctx);
    case "update_graph":      return toolUpdateGraph(input, ctx);
    case "list_triggers":     return toolListTriggers(ctx);
    case "create_trigger":    return toolCreateTrigger(input, ctx);
    case "list_configs":      return toolListConfigs(ctx);
    default: return { ok: false, error: `unknown tool: ${name}` };
  }
}

function toolGetCurrentGraph(ctx) {
  if (!ctx.currentGraph) return { ok: true, graph: null, note: "Canvas is empty." };
  return { ok: true, graph: ctx.currentGraph };
}

function toolUpdateGraph(input, ctx) {
  if (!input || typeof input.dsl !== "object" || !input.dsl) {
    return { ok: false, error: "`dsl` must be an object" };
  }
  // parseDag accepts an object directly. It throws ValidationError on issues.
  try {
    const parsed = parseDag(input.dsl);
    ctx.proposedGraph = parsed;
    ctx.currentGraph  = parsed;   // subsequent get_current_graph reads see the update
    return {
      ok: true,
      summary: `Validated. ${parsed.nodes.length} node(s), ${parsed.edges?.length || 0} edge(s). The editor will apply this DSL on the user side; the user must click Save to persist.`,
    };
  } catch (e) {
    return {
      ok: false,
      error: e.message || "validation failed",
      details: e.details || undefined,
    };
  }
}

async function toolListTriggers(ctx) {
  const params = [ctx.workspaceId];
  const where = ["workspace_id = $1"];
  if (ctx.graphId) { params.push(ctx.graphId); where.push(`graph_id=$${params.length}`); }
  const { rows } = await pool.query(
    `SELECT id, name, graph_id, type, config, enabled, fire_count, last_fired_at
       FROM triggers WHERE ${where.join(" AND ")}
       ORDER BY created_at DESC
       LIMIT 50`,
    params,
  );
  return {
    ok: true,
    scope: ctx.graphId ? "current-graph" : "all",
    triggers: rows.map(r => ({
      id: r.id, name: r.name, type: r.type,
      config: r.config, enabled: r.enabled,
      graphId: r.graph_id, fireCount: r.fire_count,
    })),
  };
}

async function toolCreateTrigger(input, ctx) {
  if (!ctx.graphId) {
    return {
      ok: false,
      error: "Cannot create a trigger before the workflow is saved. Tell the user to click Save in the toolbar, then ask them to retry.",
    };
  }
  const { name, type, config: triggerCfg } = input || {};
  if (!name || !type) return { ok: false, error: "name and type are required" };
  try {
    triggerRegistry.validateConfig(type, triggerCfg || {});
  } catch (e) {
    return { ok: false, error: `config did not validate: ${e.message}` };
  }
  // Verify the target graph belongs to the caller's workspace before
  // attaching a trigger to it.
  const { rows: gs } = await pool.query(
    "SELECT id FROM graphs WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL",
    [ctx.graphId, ctx.workspaceId],
  );
  if (gs.length === 0) {
    return { ok: false, error: "graph not found in this workspace" };
  }
  const id = uuid();
  await pool.query(
    `INSERT INTO triggers (id, name, graph_id, type, config, enabled, workspace_id, updated_by)
     VALUES ($1,$2,$3,$4,$5,true,$6,$7)`,
    [id, name, ctx.graphId, type, JSON.stringify(triggerCfg || {}), ctx.workspaceId, ctx.userId || null],
  );
  await syncTrigger(id);
  ctx.triggerCreated = { id, name, type };
  return {
    ok: true,
    summary: `Trigger "${name}" (${type}) created and enabled. It will start firing the workflow now.`,
    trigger: { id, name, type },
  };
}

async function toolListConfigs(ctx) {
  const { rows } = await pool.query(
    `SELECT name, type, description FROM configs WHERE workspace_id=$1 ORDER BY name`,
    [ctx.workspaceId],
  );
  return { ok: true, configs: rows };
}

// ──────────────────────────────────────────────────────────────────────
// Provider abstraction. Two paths through the same agent loop, one per
// API shape. Both return the final assistant text and append to ctx.traces
// as tool calls fire.
// ──────────────────────────────────────────────────────────────────────

const MAX_TOOL_TURNS = 8;

async function runAgentLoop({ system, messages, ctx }) {
  if (config.ai.provider === "anthropic") {
    return runAnthropicAgent({ system, messages, ctx });
  }
  return runOpenAIAgent({ system, messages, ctx });
}

// -------- plain (non-tool) calls used by /chat --------

async function callPlainLlm(system, messages) {
  if (config.ai.provider === "anthropic") return callAnthropicPlain(system, messages);
  return callOpenAIPlain(system, messages);
}

async function callOpenAIPlain(system, messages) {
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

async function callAnthropicPlain(system, messages) {
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
    throw new HttpError(res.status, "AI_ERROR", anthropicErrHint(res.status, txt));
  }
  const data = await res.json();
  const blocks = Array.isArray(data?.content) ? data.content : [];
  return blocks.filter(b => b.type === "text").map(b => b.text).join("");
}

// -------- Anthropic agent loop --------

async function runAnthropicAgent({ system, messages, ctx }) {
  const url = `${config.ai.baseUrl.replace(/\/$/, "")}/messages`;
  // Anthropic messages can carry mixed content blocks; build them from our
  // {role, content} pairs (content is plain text from the user-facing chat).
  const conversation = messages.map(m => ({
    role:    m.role,
    content: [{ type: "text", text: m.content }],
  }));

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": config.ai.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:       config.ai.model,
        max_tokens:  config.ai.maxTokens,
        system,
        tools:       TOOL_DEFS,
        messages:    conversation,
      }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new HttpError(res.status, "AI_ERROR", anthropicErrHint(res.status, txt));
    }
    const data = await res.json();
    const blocks = Array.isArray(data?.content) ? data.content : [];

    // Append the assistant message verbatim — Anthropic requires the full
    // content blocks (including tool_use ids) to be echoed when we send
    // back tool_result on the next turn.
    conversation.push({ role: "assistant", content: blocks });

    const toolUses = blocks.filter(b => b.type === "tool_use");
    if (toolUses.length === 0) {
      // Final answer — concatenate all text blocks.
      return blocks.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
    }

    // Run every tool call in this turn and feed results back together.
    const results = [];
    for (const tu of toolUses) {
      const result = await runTool(tu.name, tu.input || {}, ctx);
      ctx.traces.push({ tool: tu.name, input: tu.input || {}, summary: summariseResult(tu.name, result) });
      results.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: JSON.stringify(result),
        is_error: !result?.ok,
      });
    }
    conversation.push({ role: "user", content: results });
  }

  // Bailed out because the model kept calling tools forever — return whatever
  // the last assistant text was, plus a note. (Rare; the cap is generous.)
  return "(I hit my tool-use limit before finishing. The last set of changes are applied; ask me to continue if more is needed.)";
}

// -------- OpenAI agent loop (works with any chat-completions-compatible
// provider that supports tool calls). --------

async function runOpenAIAgent({ system, messages, ctx }) {
  const url = `${config.ai.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const conversation = [
    { role: "system", content: system },
    ...messages.map(m => ({ role: m.role, content: m.content })),
  ];
  const tools = TOOL_DEFS.map(t => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type":  "application/json",
        "authorization": `Bearer ${config.ai.apiKey}`,
      },
      body: JSON.stringify({
        model:       config.ai.model,
        messages:    conversation,
        tools,
        tool_choice: "auto",
        max_tokens:  config.ai.maxTokens,
        temperature: 0.3,
      }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new HttpError(res.status, "AI_ERROR", `OpenAI: ${res.status} ${txt.slice(0, 500)}`);
    }
    const data = await res.json();
    const choice = data?.choices?.[0];
    const msg = choice?.message;
    if (!msg) throw new HttpError(502, "AI_ERROR", "OpenAI returned no message");

    conversation.push({
      role: "assistant",
      content: msg.content || null,
      tool_calls: msg.tool_calls || undefined,
    });

    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (calls.length === 0) {
      return (msg.content || "").trim();
    }
    for (const c of calls) {
      const name = c.function?.name;
      let parsed = {};
      try { parsed = c.function?.arguments ? JSON.parse(c.function.arguments) : {}; }
      catch { parsed = {}; }
      const result = await runTool(name, parsed, ctx);
      ctx.traces.push({ tool: name, input: parsed, summary: summariseResult(name, result) });
      conversation.push({
        role:         "tool",
        tool_call_id: c.id,
        content:      JSON.stringify(result),
      });
    }
  }
  return "(I hit my tool-use limit before finishing.)";
}

function summariseResult(name, result) {
  if (!result?.ok) return `error: ${result?.error || "unknown"}`;
  if (name === "update_graph")    return result.summary || "graph updated";
  if (name === "create_trigger")  return result.summary || "trigger created";
  if (name === "list_triggers")   return `${result.triggers?.length || 0} trigger(s)`;
  if (name === "list_configs")    return `${result.configs?.length || 0} config(s)`;
  if (name === "get_current_graph") return result.graph
    ? `current graph: ${result.graph.name} (${result.graph.nodes?.length || 0} nodes)`
    : "no graph";
  return "ok";
}

function anthropicErrHint(status, txt) {
  let hint = "";
  if (status === 401) {
    const k = config.ai.apiKey;
    const masked = k ? `${k.slice(0, 8)}…${k.slice(-4)} (${k.length} chars)` : "(none)";
    const prefixWrong = k && !k.startsWith("sk-ant-");
    hint = ` — server received key ${masked}.` +
      (prefixWrong ? " The key does not start with sk-ant-, which Anthropic requires." : "") +
      " Common causes: trailing whitespace in .env, wrong key copied (OpenAI vs Anthropic), or revoked key. Check GET /ai/status.";
  }
  return `Anthropic: ${status} ${String(txt).slice(0, 500)}${hint}`;
}

export default router;
