// jira.issue.transition — transition a Jira Cloud issue to a new status.
//
// Callers usually know the human-readable name ("Done") rather than the
// numeric transition id, and the id is workflow-specific per Jira project.
// When transitionName is passed without an id, we GET the issue's
// available transitions and resolve by case-insensitive name match.

import { servePlugin } from "@daisy-workflow/plugin-sdk";
import fs from "node:fs";

const manifest = JSON.parse(
  fs.readFileSync(new URL("./manifest.json", import.meta.url), "utf8"),
);

function loadJiraAuth(ctx, configName = "jira") {
  const cfg = ctx?.config?.[configName];
  if (!cfg) throw new Error(`Jira config "${configName}" not found in workspace.`);
  const host  = String(cfg.host  || "").replace(/\/+$/, "");
  const email = String(cfg.email || "");
  const token = String(cfg.apiToken || "");
  if (!host || !email || !token) {
    throw new Error(`Jira config "${configName}" missing host/email/apiToken.`);
  }
  const basic = Buffer.from(`${email}:${token}`).toString("base64");
  return {
    host,
    headers: {
      "Authorization": `Basic ${basic}`,
      "Accept":        "application/json",
      "Content-Type":  "application/json",
    },
  };
}

async function jiraFetch({ host, headers }, path, init = {}, timeoutMs = 15000, signal) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error(`Jira request timed out after ${timeoutMs}ms`)), timeoutMs);
  const onUpstream = () => ac.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) ac.abort(signal.reason);
    else signal.addEventListener("abort", onUpstream, { once: true });
  }
  try {
    const res = await fetch(`${host}${path}`, { ...init, headers: { ...headers, ...(init.headers || {}) }, signal: ac.signal });
    const text = res.status === 204 ? "" : await res.text();
    let body; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!res.ok) {
      const msg = body?.errorMessages?.[0] || body?.message || `HTTP ${res.status}`;
      const err = new Error(`Jira ${init.method || "GET"} ${path} failed: ${msg}`);
      err.status = res.status; err.body = body;
      throw err;
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(t);
    if (signal) signal.removeEventListener?.("abort", onUpstream);
  }
}

function toAdf(text) {
  if (text == null || text === "") return null;
  if (typeof text === "object" && text.type === "doc") return text;
  return {
    type: "doc", version: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text: String(text) }] }],
  };
}

servePlugin({
  manifest,
  async execute(input, ctx) {
    const {
      issueKey, transitionId, transitionName, comment, resolution,
      config = "jira", timeoutMs = 15000,
    } = input || {};

    if (!issueKey) throw new Error("issueKey is required");
    if (!transitionId && !transitionName) {
      throw new Error("either transitionId or transitionName is required");
    }

    const auth = loadJiraAuth(ctx, config);

    // Resolve name → id when only the name was supplied. The set of
    // available transitions depends on the current status + the issue's
    // workflow, so we ask Jira each time rather than caching.
    let id = transitionId;
    let resolvedName = transitionName || null;
    if (!id) {
      const { body: tBody } = await jiraFetch(
        auth,
        `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`,
        { method: "GET" },
        timeoutMs,
        ctx?.signal,
      );
      const wanted = String(transitionName).trim().toLowerCase();
      const match = (tBody?.transitions || []).find(t => String(t.name).toLowerCase() === wanted);
      if (!match) {
        const available = (tBody?.transitions || []).map(t => t.name).join(", ") || "(none)";
        throw new Error(`transition "${transitionName}" is not available on ${issueKey}. Available: ${available}`);
      }
      id = match.id;
      resolvedName = match.name;
    }

    // POST the transition. Optional `update` (for comment) and `fields`
    // (for resolution) ride along in the same request — Jira applies
    // them atomically with the status change.
    const reqBody = { transition: { id: String(id) } };
    if (comment && String(comment).trim()) {
      reqBody.update = { comment: [{ add: { body: toAdf(comment) } }] };
    }
    if (resolution) {
      reqBody.fields = { resolution: { name: resolution } };
    }

    const { status } = await jiraFetch(
      auth,
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`,
      { method: "POST", body: JSON.stringify(reqBody) },
      timeoutMs,
      ctx?.signal,
    );

    return {
      ok:             true,
      status,
      transitionId:   String(id),
      transitionName: resolvedName,
      issueKey,
      url:            `${auth.host}/browse/${encodeURIComponent(issueKey)}`,
    };
  },
  async readyz() { return true; },
});
