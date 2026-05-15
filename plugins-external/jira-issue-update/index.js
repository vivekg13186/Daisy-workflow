// jira.issue.update — patch fields on a Jira Cloud issue.

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
    // PUT /issue returns 204 No Content on success — no body to parse.
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
      issueKey, summary, description, assignee, priority,
      labels, components, dueDate, customFields,
      config = "jira", timeoutMs = 15000,
    } = input || {};

    if (!issueKey) throw new Error("issueKey is required");

    const auth = loadJiraAuth(ctx, config);

    // Build a partial-update `fields` object. Only include keys the
    // caller explicitly passed — Jira treats omitted fields as
    // unchanged, but a null on a custom field will clear it.
    const fields = {};
    if (summary != null)        fields.summary = summary;
    if (description !== undefined) fields.description = toAdf(description);
    if (assignee !== undefined) fields.assignee = assignee === "" ? null : { accountId: assignee };
    if (priority)               fields.priority = { name: priority };
    if (Array.isArray(labels))     fields.labels     = labels;
    if (Array.isArray(components)) fields.components = components.map(name => ({ name }));
    if (dueDate !== undefined)  fields.duedate = dueDate || null;
    if (customFields && typeof customFields === "object") {
      for (const [k, v] of Object.entries(customFields)) fields[k] = v;
    }

    if (Object.keys(fields).length === 0) {
      // No-op update would still cost an HTTP round trip and an audit
      // entry in Jira. Surface the mistake early.
      throw new Error("update called with no fields to change");
    }

    const { status } = await jiraFetch(
      auth,
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}`,
      { method: "PUT", body: JSON.stringify({ fields }) },
      timeoutMs,
      ctx?.signal,
    );

    return {
      ok:       true,
      status,
      issueKey,
      url:      `${auth.host}/browse/${encodeURIComponent(issueKey)}`,
      issue:    null,    // PUT returns 204; consumer can re-fetch via jira.issue.get
    };
  },
  async readyz() { return true; },
});
