// MUST stay at the top — telemetry.js starts the OpenTelemetry SDK on
// import, and the auto-instrumentations only hook modules loaded AFTER
// sdk.start(). Anything imported above this line wouldn't be traced.
import "./telemetry.js";

import http from "node:http";
import express from "express";
import cors from "cors";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import { config } from "./config.js";
import { log } from "./utils/logger.js";
import { HttpError } from "./utils/errors.js";
import { loadBuiltins } from "./plugins/registry.js";
import authRouter from "./api/auth.js";
import graphsRouter from "./api/graphs.js";
import executionsRouter from "./api/executions.js";
import pluginsRouter from "./api/plugins.js";
import aiRouter from "./api/ai.js";
import triggersRouter from "./api/triggers.js";
import webhooksRouter from "./api/webhooks.js";
import configsRouter from "./api/configs.js";
import agentsRouter  from "./api/agents.js";
import memoryRouter  from "./api/memory.js";
import { attachWss } from "./ws/broadcast.js";

await loadBuiltins();

const app = express();
// Cookie-aware CORS: when the frontend lives on a different origin
// (dev: 5173 vs API on 3000) we have to mirror the Origin header back
// + send Access-Control-Allow-Credentials:true, otherwise the browser
// silently drops Set-Cookie on the refresh-cookie response.
app.use(cors({
  origin: (origin, cb) => cb(null, origin || true),  // reflect any origin (dev-friendly; tighten in prod)
  credentials: true,
}));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use(morgan("tiny"));

app.get("/health", (_req, res) => res.json({ ok: true, env: config.env }));

// Auth lives BEFORE the protected routes — and is itself unprotected
// at the router level (login/refresh are public; /me uses requireUser
// inline).
app.use("/auth", authRouter);

app.use("/graphs", graphsRouter);
app.use("/executions", executionsRouter);
app.use("/plugins", pluginsRouter);
app.use("/ai", aiRouter);
app.use("/triggers", triggersRouter);
app.use("/configs",  configsRouter);
app.use("/agents",   agentsRouter);
app.use("/memory",   memoryRouter);
// Public webhook endpoint — bypasses /api proxy in dev because the path is
// absolute (/webhooks/<id>). External services hit it directly.
app.use("/webhooks", webhooksRouter);

app.use((err, _req, res, _next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.code, message: err.message, details: err.details });
  }
  log.error("unhandled error", { error: err.message, stack: err.stack });
  res.status(500).json({ error: "INTERNAL", message: err.message });
});

const server = http.createServer(app);
attachWss(server);

server.listen(config.port, () => {
  log.info("api listening", { port: config.port });
});

// In dev, also spin up an in-process worker so a single `npm run dev` boots everything.
if (config.env !== "production") {
  await import("./worker.js");
}
