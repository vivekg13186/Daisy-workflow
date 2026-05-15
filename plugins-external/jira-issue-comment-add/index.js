// jira.issue.comment.add — add a comment to a Jira Cloud issue.

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
      issueKey, comment, visibility,
      config = "jira", timeoutMs = 15000,
    } = input || {};

    if (!issueKey) throw new Error("issueKey is required");
    if (!comment || !String(comment).trim()) throw new Error("comment is required");

    const auth = loadJiraAuth(ctx, config);

    const body = { body: toAdf(comment) };
    if (visibility && visibility.type && visibility.value) {
      body.visibility = { type: visibility.type, value: visibility.value };
    }

    const { status, body: respBody } = await jiraFetch(
      auth,
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`,
      { method: "POST", body: JSON.stringify(body) },
      timeoutMs,
      ctx?.signal,
    );

    return {
      ok:      true,
      status,
      comment: respBody,
      url:     `${auth.host}/browse/${encodeURIComponent(issueKey)}?focusedCommentId=${encodeURIComponent(respBody?.id || "")}`,
    };
  },
  async readyz() { return true; },
});
