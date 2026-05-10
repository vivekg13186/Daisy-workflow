-- Agents — named LLM personas that can be plugged into a workflow via the
-- `agent` plugin.
--
-- Each row carries a free-text `prompt` (the system prompt the LLM runs
-- against) plus a reference to a stored `ai.provider` configuration that
-- supplies the API key + model. The plugin sends the workflow's input
-- text + the agent's prompt to the provider and parses the response as
-- JSON.
--
-- We reference the provider configuration by *name* (not id) to match the
-- pattern every other config-aware plugin uses (`email.send`,
-- `mqtt.publish`, `sql.*`).

CREATE TABLE IF NOT EXISTS agents (
  id           UUID PRIMARY KEY,
  title        TEXT NOT NULL,
  prompt       TEXT NOT NULL,
  config_name  TEXT NOT NULL,
  description  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_title ON agents (title);
CREATE INDEX        IF NOT EXISTS idx_agents_config_name ON agents (config_name);
