// Shared helpers for the `agent` action plugin.
//
// Lives outside src/plugins/builtin/ so the plugin auto-loader doesn't
// register it as an action.

import { pool } from "../../db/pool.js";

/**
 * Look up the agent row + its linked ai.provider config from
 * ctx.config[config_name]. The configs map is loaded into ctx.config by
 * the worker at execution start, so the plaintext apiKey is available
 * here without us re-reading the DB.
 */
export async function loadAgent(ctx, title) {
  if (!title || typeof title !== "string") {
    throw new Error("agent: `agent` (title) is required");
  }
  const { rows } = await pool.query(
    "SELECT title, prompt, config_name FROM agents WHERE title = $1",
    [title],
  );
  if (rows.length === 0) {
    throw new Error(
      `agent: no agent titled "${title}". Create one on the Home page → Agents.`,
    );
  }
  const agent = rows[0];
  const cfg = ctx?.config?.[agent.config_name];
  if (!cfg || typeof cfg !== "object") {
    throw new Error(
      `agent "${title}": config "${agent.config_name}" not found. ` +
      `Create a configuration of type ai.provider on the Home page → Configurations.`,
    );
  }
  if (!cfg.apiKey) throw new Error(`agent "${title}": config "${agent.config_name}" has no apiKey set`);
  if (!cfg.model)  throw new Error(`agent "${title}": config "${agent.config_name}" has no model set`);
  if (!cfg.provider) throw new Error(`agent "${title}": config "${agent.config_name}" has no provider set`);
  return { agent, cfg };
}

/**
 * Drive a single LLM turn against the configured provider. Returns
 *
 *   { text:   <full response text>,
 *     usage:  { inputTokens, outputTokens } }
 *
 * The agent's `prompt` is wired in as the system prompt; the workflow's
 * `input` text is the single user message.
 */
export async function callProvider({ cfg, system, userText, maxTokens = 2048 }) {
  if (cfg.provider === "anthropic") {
    return callAnthropic(cfg, system, userText, maxTokens);
  }
  return callOpenAI(cfg, system, userText, maxTokens);
}

async function callAnthropic(cfg, system, userText, maxTokens) {
  const baseUrl = (cfg.baseUrl || "https://api.anthropic.com/v1").replace(/\/$/, "");
  const res = await fetch(`${baseUrl}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model:      cfg.model,
      max_tokens: maxTokens,
      system,
      messages:   [{ role: "user", content: userText }],
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`agent (anthropic): ${res.status} ${String(txt).slice(0, 500)}`);
  }
  const data = await res.json();
  const blocks = Array.isArray(data?.content) ? data.content : [];
  const text = blocks.filter(b => b.type === "text").map(b => b.text).join("");
  return {
    text,
    usage: {
      inputTokens:  data?.usage?.input_tokens  ?? 0,
      outputTokens: data?.usage?.output_tokens ?? 0,
    },
  };
}

async function callOpenAI(cfg, system, userText, maxTokens) {
  const baseUrl = (cfg.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type":  "application/json",
      "authorization": `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model:    cfg.model,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user",   content: userText },
      ],
      temperature: 0.3,
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`agent (openai): ${res.status} ${String(txt).slice(0, 500)}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || "";
  return {
    text,
    usage: {
      inputTokens:  data?.usage?.prompt_tokens     ?? 0,
      outputTokens: data?.usage?.completion_tokens ?? 0,
    },
  };
}

/**
 * Try to parse the model's text response as JSON. Tolerates a leading /
 * trailing ``` fence (the most common deviation when models add
 * explanatory text). Returns the parsed value on success, or null when
 * nothing valid is found.
 */
export function tryParseJson(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Strip a fenced code block if the response is wrapped in one.
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced ? fenced[1] : trimmed;

  // Cheap fast-path: starts with { or [.
  const firstChar = candidate.trim().charAt(0);
  if (firstChar !== "{" && firstChar !== "[") return null;

  try { return JSON.parse(candidate); } catch { /* fall through */ }

  // Last resort: find the first { ... } or [ ... ] span and try to parse it.
  const m = /[\{\[][\s\S]*[\}\]]/.exec(candidate);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

/**
 * Extract a `confidence` number from a parsed JSON result if the model
 * happened to include one. Accepts values 0–1 or 0–100; normalises both
 * into a 0–1 float. Returns null when absent or non-numeric.
 */
export function extractConfidence(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  const c = parsed.confidence;
  if (typeof c !== "number" || !isFinite(c)) return null;
  if (c >= 0 && c <= 1) return c;
  if (c > 1 && c <= 100) return c / 100;
  return null;
}
