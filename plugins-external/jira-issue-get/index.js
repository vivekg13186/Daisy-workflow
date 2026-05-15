// jira.issue.get — fetch a single Jira Cloud issue by key.
//
// Daisy wires this into a workflow as a node; auth comes from a workspace
// `generic` config holding host/email/apiToken (configurable via the `config`
// input, default name "jira"). The plugin reads it from `ctx.config`.

import { servePlugin } from "@daisy-workflow/plugin-sdk";
import fs from "node:fs";

const manifest = JSON.parse(
  fs.readFileSync(new URL("./manifest.json", import.meta.url), "utf8"),
);

// ── Shared Jira client (auth + fetch wrapper) ──────────────────────────
// Duplicated across the jira-* plugins on purpose: each external plugin
// is self-contained so it can be built, shipped, and deployed without
// pulling in a sibling folder.
function loadJiraAuth(ctx, configName = "jira") {
  const cfg = ctx?.config?.[configName];
  if (!cfg) {
    throw new Error(
      `Jira config "${configName}" not found in workspace. ` +
      `Add a generic config on the Configurations page with host, email, apiToken.`,
    );
  }
  const host  = String(cfg.host  || "").replace(/\/+$/, "");
  const email = String(cfg.email || "");
  const token = String(cfg.apiToken || "");
  if (!host || !email || !token) {
    throw new Error(
      `Jira config "${configName}" is missing one of host/email/apiToken.`,
    );
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
    const url = `${host}${path}`;
    const res = await fetch(url, { ...init, headers: { ...headers, ...(init.headers || {}) }, signal: ac.signal });
    const text = await res.text();
    let body; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!res.ok) {
      const msg = body?.errorMessages?.[0] || body?.message || `HTTP ${res.status}`;
      const err = new Error(`Jira ${init.method || "GET"} ${path} failed: ${msg}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return { status: res.status, body, url };
  } finally {
    clearTimeout(t);
    if (signal) signal.removeEventListener?.("abort", onUpstream);
  }
}

// ── execute ────────────────────────────────────────────────────────────
servePlugin({
  manifest,
  async execute(input, ctx) {
    const { issueKey, config = "jira", fields, expand, timeoutMs = 15000 } = input || {};
    if (!issueKey) throw new Error("issueKey is required");

    const auth = loadJiraAuth(ctx, config);
    const qs = new URLSearchParams();
    if (Array.isArray(fields) && fields.length) qs.set("fields", fields.join(","));
    if (Array.isArray(expand) && expand.length) qs.set("expand", expand.join(","));
    const suffix = qs.toString() ? `?${qs}` : "";

    const { status, body, url } = await jiraFetch(
      auth,
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}${suffix}`,
      { method: "GET" },
      timeoutMs,
      ctx?.signal,
    );

    return {
      ok:     true,
      status,
      issue:  body,
      url:    `${auth.host}/browse/${encodeURIComponent(issueKey)}`,
    };
  },
  async readyz() { return true; },
});
