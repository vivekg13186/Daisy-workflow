-- node_states.attempts shouldn't be NOT NULL.
--
-- The executor's persistNodeState hook fires three times per node
-- (RUNNING with the resolved inputs, then SUCCESS or FAILED with the
-- final outcome). The first two writes don't know how many attempts
-- the run will end up taking, so they pass NULL — the NOT NULL
-- constraint then rejects the INSERT with
--     null value in column "attempts" of relation "node_states"
--     violates not-null constraint
--
-- Drop the constraint; keep the DEFAULT 0 so any explicit null becomes
-- 0 only when the column is omitted from the INSERT (it isn't, in our
-- upsert, but the default is harmless).

ALTER TABLE node_states ALTER COLUMN attempts DROP NOT NULL;
