import { Router } from "express";
import { pool } from "../db/pool.js";
import { NotFoundError } from "../utils/errors.js";

const router = Router();

router.get("/", async (req, res, next) => {
  try {
    const { graphId, limit = 50 } = req.query;
    const params = [];
    let where = "";
    if (graphId) { params.push(graphId); where = "WHERE graph_id=$1"; }
    params.push(Math.min(parseInt(limit, 10) || 50, 200));
    const { rows } = await pool.query(
      `SELECT id, graph_id, status, started_at, finished_at, created_at, error
       FROM executions ${where}
       ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    );
    res.json(rows);
  } catch (e) { next(e); }
});

router.get("/:id", async (req, res, next) => {
  try {
    const { rows: execs } = await pool.query(
      "SELECT * FROM executions WHERE id=$1", [req.params.id],
    );
    if (execs.length === 0) throw new NotFoundError("execution");
    // Per-node history is no longer in Postgres — clients should read the
    // post-execution summary from executions.context.nodes (the engine's ctx).
    res.json(execs[0]);
  } catch (e) { next(e); }
});

/** DELETE /executions/:id — remove an execution row. */
router.delete("/:id", async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(
      "DELETE FROM executions WHERE id=$1", [req.params.id],
    );
    if (rowCount === 0) throw new NotFoundError("execution");
    res.status(200).json({ ok: true, id: req.params.id, deleted: "execution" });
  } catch (e) { next(e); }
});

export default router;
