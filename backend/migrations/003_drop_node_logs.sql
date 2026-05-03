-- Per-node lifecycle is no longer persisted to Postgres. Events are now
-- appended to backend/logs/node-events.log as JSONL, and the post-execution
-- summary lives inside executions.context.nodes (so the UI reads from there).
DROP TABLE IF EXISTS node_logs;
