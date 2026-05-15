// jira.issue.create — create a Jira Cloud issue.

import { servePlugin } from "@daisy-workflow/plugin-sdk";
import fs from "node:fs";

const manifest = JSON.parse(
  fs.readFileSync(new URL("./manifest.json", import.meta.url), "utf8"),
);

// ── Shared Jira client ──────────────────────────────────────────────────
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
    const text = await res.text();
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

// Jira Cloud REST v3 requires rich-text fields as ADF (Atlassian Document
// Format). Customers will overwhelmingly pass plain text — wrap it for
// them. If the caller passed something that's already an ADF doc, leave
// it alone.
function toAdf(text) {
  if (text == null || text === "") return null;
  if (typeof text === "object" && text.type === "doc") return text;  // already ADF
  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: String(text) }],
      },
    ],
  };
}

// ── execute ────────────────────────────────────────────────────────────
servePlugin({
  manifest,
  async execute(input, ctx) {
    const {
      projectKey, summary, issueType = "Task", description,
      assignee, reporter, priority, labels, components, dueDate,
      customFields, config = "jira", timeoutMs = 15000,
    } = input || {};

    if (!projectKey) throw new Error("projectKey is required");
    if (!summary)    throw new Error("summary is required");

    const auth = loadJiraAuth(ctx, config);

    // Build the `fields` object the way Jira expects. Only include keys
    // the caller actually set — sending nulls trips Jira validation on
    // fields the workspace marks required.
    const fields = {
      project:   { key: projectKey },
      summary,
      issuetype: { name: issueType },
    };
    if (description != null && description !== "") fields.description = toAdf(description);
    if (assignee)    fields.assignee = { accountId: assignee };
    if (reporter)    fields.reporter = { accountId: reporter };
    if (priority)    fields.priority = { name: priority };
    if (Array.isArray(labels) && labels.length)         fields.labels     = labels;
    if (Array.isArray(components) && components.length) fields.components = components.map(name => ({ name }));
    if (dueDate)     fields.duedate = dueDate;
    if (customFields && typeof customFields === "object") {
      for (const [k, v] of Object.entries(customFields)) fields[k] = v;
    }

    const { status, body } = await jiraFetch(
      auth,
      "/rest/api/3/issue",
      { method: "POST", body: JSON.stringify({ fields }) },
      timeoutMs,
      ctx?.signal,
    );

    return {
      ok:     true,
      status,
      issue:  body,                            // { id, key, self }
      url:    body?.key ? `${auth.host}/browse/${encodeURIComponent(body.key)}` : null,
    };
  },
  async readyz() { return true; },
});
