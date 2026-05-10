-- Per-node execution state — written incrementally as the executor runs,
-- not just at the end. Foundation for crash recovery, "resume from failed
-- node" UX, and exactly-once guarantees.
--
-- One row per (execution, node). The same row is updated through the
-- node's lifecycle: pending → running → success | failed | skipped.
-- attempts is bumped on retry. resolved_inputs is the post-${...}-resolution
-- input object the plugin saw, captured when the node entered RUNNING so
-- that "Edit data and resume" can let the user mutate it before re-run.

CREATE TABLE IF NOT EXISTS node_states (
  execution_id     UUID NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  node_name        TEXT NOT NULL,
  status           TEXT NOT NULL,                  -- pending|running|success|failed|skipped
  attempts         INT  NOT NULL DEFAULT 0,
  resolved_inputs  JSONB,                          -- as the plugin saw them on the last attempt
  output           JSONB,
  error            TEXT,
  reason           TEXT,                           -- e.g. "executeIf=false" / "upstream foo skipped"
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (execution_id, node_name)
);

CREATE INDEX IF NOT EXISTS idx_node_states_running
  ON node_states (execution_id) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_node_states_failed
  ON node_states (execution_id) WHERE status = 'failed';
