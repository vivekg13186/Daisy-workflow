// @daisy-dag/plugin-sdk — minimal helper for authoring Daisy-DAG
// external plugins.
//
// Wires the four-endpoint HTTP contract (/manifest, /healthz,
// /readyz, /execute) so the only code the plugin author needs to
// write is the body of execute(input, ctx). Zero runtime deps —
// uses Node's built-in `http` server + global `fetch`.
//
// Usage:
//
//   import { servePlugin } from "@daisy-dag/plugin-sdk";
//   import manifest from "./manifest.json" with { type: "json" };
//
//   servePlugin({
//     manifest,
//     async execute(input, ctx) {
//       const r = await fetch("https://...", { signal: ctx.signal });
//       return { posts: await r.json() };
//     },
//     // Optional: custom readiness check. Default returns true.
//     // async readyz() { return await pingUpstream(); },
//   });
//
// What ctx carries:
//   {
//     executionId, workspaceId, nodeName,    // for log / trace correlation
//     config,                                 // plaintext values for configRefs
//     deadlineMs,                             // wall-clock budget set by the engine
//     signal,                                 // AbortSignal — pass to fetch / pg / etc.
//   }
//
// Return shape:
//   • Recommended:  return { output: { ... }, usage?: { ... } }
//   • Also accepted: return { ... }  ← the whole object IS the output
//
// Errors thrown inside execute() become 500 responses with
// `{ error: "<message>" }`. The engine surfaces these as node
// failures and applies its retry / fallback / self-heal policies.

import http from "node:http";

/**
 * Boot the plugin's HTTP server.
 *
 * @param {object} opts
 *   - manifest:  the plugin's manifest JSON (must export name +
 *                version + valid input/output schemas).
 *   - execute:   async (input, ctx) => output | { output, usage }
 *   - readyz?:   async () => boolean — return false to make /readyz
 *                respond 503. Default: always true.
 *   - port?:     PORT env var or 8080 by default.
 *   - host?:     default "0.0.0.0" (works in-container).
 *   - log?:      function(level, msg, meta) — default console.log
 *                with a `[{name}]` prefix. Pass a no-op to silence.
 *
 * Returns the http.Server instance (for tests / advanced shutdown).
 */
export function servePlugin({
  manifest,
  execute,
  readyz   = async () => true,
  port     = parseInt(process.env.PORT || "8080", 10),
  host     = process.env.HOST || "0.0.0.0",
  log      = defaultLog(manifest?.name || "plugin"),
} = {}) {
  validateManifest(manifest);
  if (typeof execute !== "function") {
    throw new Error("servePlugin: `execute` must be an async function");
  }

  const server = http.createServer(async (req, res) => {
    const t0 = Date.now();
    try {
      if (req.method === "GET" && req.url === "/manifest") {
        return reply(res, 200, manifest);
      }
      if (req.method === "GET" && req.url === "/healthz") {
        return reply(res, 200, { ok: true });
      }
      if (req.method === "GET" && req.url === "/readyz") {
        try {
          const ok = await readyz();
          return reply(res, ok ? 200 : 503, { ok: !!ok });
        } catch (e) {
          return reply(res, 503, { ok: false, error: shortErr(e) });
        }
      }
      if (req.method === "POST" && req.url === "/execute") {
        return handleExecute(req, res, execute, log, t0);
      }
      return reply(res, 404, { error: "not found" });
    } catch (e) {
      // Last-resort guard: never let an unhandled error tear down
      // the server.
      reply(res, 500, { error: shortErr(e) });
    }
  });

  server.listen(port, host, () => {
    log("info", "plugin listening", { port, host, name: manifest.name, version: manifest.version });
  });

  // Graceful shutdown on SIGTERM / SIGINT so docker stop / k8s
  // doesn't kill in-flight requests.
  const close = () => server.close(() => process.exit(0));
  process.on("SIGTERM", close);
  process.on("SIGINT",  close);

  return server;
}

// ────────────────────────────────────────────────────────────────────
// /execute handler
// ────────────────────────────────────────────────────────────────────

async function handleExecute(req, res, execute, log, t0) {
  let body;
  try { body = await readJson(req); }
  catch (e) { return reply(res, 400, { error: e.message }); }

  const input    = body?.input || {};
  const ctxBase  = {
    executionId: body?.executionId  || null,
    workspaceId: body?.workspaceId  || null,
    nodeName:    body?.nodeName     || null,
    config:      body?.config       || {},
    deadlineMs:  Number.isFinite(body?.deadlineMs) ? body.deadlineMs : null,
  };

  // Wire an AbortSignal that fires when:
  //   • The client (engine) drops the connection.
  //   • The deadline expires.
  const ac = new AbortController();
  let deadlineTimer = null;
  const onClose = () => ac.abort(new Error("client disconnected"));
  req.on("aborted", onClose);
  req.on("close",   onClose);
  if (ctxBase.deadlineMs && ctxBase.deadlineMs > 0) {
    deadlineTimer = setTimeout(
      () => ac.abort(new Error(`plugin deadline ${ctxBase.deadlineMs}ms exceeded`)),
      ctxBase.deadlineMs,
    );
    if (typeof deadlineTimer.unref === "function") deadlineTimer.unref();
  }
  const ctx = { ...ctxBase, signal: ac.signal };

  try {
    const result = await execute(input, ctx);
    const payload = (result && typeof result === "object" && "output" in result)
      ? result                           // {output, usage?}
      : { output: result };              // back-compat: whole return IS output
    log("info", "execute ok", {
      executionId: ctxBase.executionId,
      nodeName:    ctxBase.nodeName,
      ms:          Date.now() - t0,
    });
    reply(res, 200, payload);
  } catch (e) {
    log("warn", "execute failed", {
      executionId: ctxBase.executionId,
      nodeName:    ctxBase.nodeName,
      ms:          Date.now() - t0,
      error:       shortErr(e),
    });
    reply(res, 500, { error: shortErr(e) });
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    req.off("aborted", onClose);
    req.off("close",   onClose);
  }
}

// ────────────────────────────────────────────────────────────────────
// Manifest validation
// ────────────────────────────────────────────────────────────────────

const NAME_RE    = /^[a-z][a-z0-9_.-]*$/;
const SEMVER_RE  = /^\d+\.\d+\.\d+/;

export function validateManifest(m) {
  if (!m || typeof m !== "object") {
    throw new Error("manifest must be an object");
  }
  if (typeof m.name !== "string" || !NAME_RE.test(m.name)) {
    throw new Error(`manifest.name must match ${NAME_RE}; got "${m.name}"`);
  }
  if (typeof m.version !== "string" || !SEMVER_RE.test(m.version)) {
    throw new Error(`manifest.version must be semver; got "${m.version}"`);
  }
  if (m.inputSchema  && typeof m.inputSchema  !== "object") throw new Error("manifest.inputSchema must be an object");
  if (m.outputSchema && typeof m.outputSchema !== "object") throw new Error("manifest.outputSchema must be an object");
  if (m.configRefs   && !Array.isArray(m.configRefs))       throw new Error("manifest.configRefs must be an array");
}

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function reply(res, code, body) {
  if (res.writableEnded) return;
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readJson(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let s = "";
    let bytes = 0;
    req.on("data", (c) => {
      bytes += c.length;
      if (bytes > maxBytes) {
        req.destroy();
        return reject(new Error("request body too large"));
      }
      s += c;
    });
    req.on("end",   () => {
      if (!s) return resolve({});
      try { resolve(JSON.parse(s)); }
      catch (e) { reject(new Error("invalid JSON body: " + e.message)); }
    });
    req.on("error", reject);
  });
}

function shortErr(e) {
  const m = (e && (e.message || String(e))) || "unknown error";
  return m.length > 800 ? m.slice(0, 800) + "…" : m;
}

function defaultLog(name) {
  return (level, msg, meta) => {
    const line = { t: new Date().toISOString(), level, name, msg, ...(meta || {}) };
    const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
    stream.write(JSON.stringify(line) + "\n");
  };
}
