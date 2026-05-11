// Public-facing endpoint for webhook triggers.
//
// Any HTTP method to /webhooks/:id looks up the trigger row and, if it's an
// enabled webhook trigger that accepts the method (and the optional shared
// secret matches), enqueues an execution with the request payload.
//
// Payload shape (also documented in triggers/builtin/webhook.js):
//   { method, path, url, headers, query, body, remoteAddr, receivedAt }

import { Router } from "express";
import { v4 as uuid } from "uuid";
import { pool } from "../db/pool.js";
import { enqueueExecution } from "../queue/queue.js";
import { log } from "../utils/logger.js";
import { limiters } from "../middleware/rateLimit.js";

const router = Router();

// Public endpoint — apply the webhook-specific limiter on every
// method. The keygen buckets by (webhook id, IP) so:
//   • One malicious IP can't flood a single webhook.
//   • One webhook ID receiving traffic from many IPs (legit fan-in
//     from a SaaS sending webhooks) isn't penalised.
router.all("/:id", limiters.webhook, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM triggers WHERE id=$1 AND type='webhook'",
      [req.params.id],
    );
    const trigger = rows[0];
    if (!trigger) return res.status(404).json({ error: "NOT_FOUND", message: "webhook not found" });
    if (!trigger.enabled) return res.status(403).json({ error: "DISABLED", message: "webhook is disabled" });

    const cfg = trigger.config || {};

    // Method allow-list (case-insensitive). "ANY" or empty list means accept anything.
    const methods = (cfg.methods || ["POST"]).map(m => String(m).toUpperCase());
    if (methods.length && !methods.includes("ANY") && !methods.includes(req.method.toUpperCase())) {
      return res.status(405).json({
        error: "METHOD_NOT_ALLOWED",
        message: `webhook accepts: ${methods.join(", ")}`,
      });
    }

    // Optional shared secret check.
    if (cfg.secret) {
      const supplied = req.get("x-webhook-secret") || req.query.secret;
      if (supplied !== cfg.secret) {
        return res.status(401).json({ error: "BAD_SECRET", message: "secret mismatch" });
      }
    }

    const payload = {
      method: req.method,
      path:   req.originalUrl.split("?")[0],
      url:    req.originalUrl,
      headers: req.headers,
      query:  req.query,
      body:   req.body,
      remoteAddr: req.ip,
      receivedAt: new Date().toISOString(),
    };

    const execId = uuid();
    await pool.query(
      `INSERT INTO executions (id, graph_id, status, inputs, context)
       VALUES ($1,$2,'queued',$3,'{}'::jsonb)`,
      [execId, trigger.graph_id, JSON.stringify(payload)],
    );
    await pool.query(
      `UPDATE triggers
         SET last_fired_at = NOW(), fire_count = fire_count + 1, updated_at = NOW()
       WHERE id = $1`,
      [trigger.id],
    );
    await enqueueExecution({ executionId: execId, graphId: trigger.graph_id });

    log.info("webhook fired", { triggerId: trigger.id, executionId: execId, method: req.method });
    res.status(202).json({ ok: true, executionId: execId });
  } catch (e) { next(e); }
});

export default router;
