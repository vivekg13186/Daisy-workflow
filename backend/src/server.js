import http from "node:http";
import express from "express";
import cors from "cors";
import morgan from "morgan";
import { config } from "./config.js";
import { log } from "./utils/logger.js";
import { HttpError } from "./utils/errors.js";
import { loadBuiltins } from "./plugins/registry.js";
import graphsRouter from "./api/graphs.js";
import executionsRouter from "./api/executions.js";
import pluginsRouter from "./api/plugins.js";
import aiRouter from "./api/ai.js";
import triggersRouter from "./api/triggers.js";
import webhooksRouter from "./api/webhooks.js";
import configsRouter from "./api/configs.js";
import agentsRouter  from "./api/agents.js";
import { attachWss } from "./ws/broadcast.js";

await loadBuiltins();

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(morgan("tiny"));

app.get("/health", (_req, res) => res.json({ ok: true, env: config.env }));

app.use("/graphs", graphsRouter);
app.use("/executions", executionsRouter);
app.use("/plugins", pluginsRouter);
app.use("/ai", aiRouter);
app.use("/triggers", triggersRouter);
app.use("/configs",  configsRouter);
app.use("/agents",   agentsRouter);
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
