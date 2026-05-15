// jira.issue.search — JQL search against Jira Cloud.

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

async function jiraFetch({ host, headers }, path, init = {}, timeoutMs = 20000, signal) {
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

servePlugin({
  manifest,
  async execute(input, ctx) {
    const {
      jql, maxResults = 50, startAt = 0, fields, expand,
      config = "jira", timeoutMs = 20000,
    } = input || {};

    if (!jql) throw new Error("jql is required");

    const auth = loadJiraAuth(ctx, config);

    // POST /search lets us send the JQL + fields list in a body without
    // URL-length limits — much friendlier than the GET variant for
    // any non-trivial query.
    const reqBody = {
      jql,
      startAt:    Math.max(0, Number(startAt) || 0),
      maxResults: Math.min(100, Math.max(1, Number(maxResults) || 50)),
    };
    if (Array.isArray(fields) && fields.length) reqBody.fields = fields;
    if (Array.isArray(expand) && expand.length) reqBody.expand = expand;

    const { status, body } = await jiraFetch(
      auth,
      "/rest/api/3/search",
      { method: "POST", body: JSON.stringify(reqBody) },
      timeoutMs,
      ctx?.signal,
    );

    return {
      ok:         true,
      status,
      issues:     Array.isArray(body?.issues) ? body.issues : [],
      total:      Number(body?.total ?? 0),
      startAt:    Number(body?.startAt ?? reqBody.startAt),
      maxResults: Number(body?.maxResults ?? reqBody.maxResults),
    };
  },
  async readyz() { return true; },
});
