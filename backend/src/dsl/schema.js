// JSON Schema for the DAG DSL.
export const dagSchema = {
  type: "object",
  required: ["name", "nodes"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1 },
    // version is auto-managed by the API (incremented per save) and is not
    // part of the user-authored YAML. We still accept the field if present
    // (e.g. legacy flows) so old YAML keeps validating, but it's optional.
    version: { type: "string" },
    description: { type: "string" },
    // Workflow-level wall-clock budget. Optional; falls back to the
    // EXECUTION_DEFAULT_WORKFLOW_TIMEOUT env var. Accepts a duration
    // string ("30m", "1h", "5000ms") or a bare number of milliseconds.
    timeout: { type: ["integer", "string"] },
    // Workflow-level default for per-node timeout. Per-node `timeout`
    // still wins; this is the "all my nodes generally need ~X" hatch.
    nodeTimeout: { type: ["integer", "string"] },
    // Maximum batch fan-out (executeBatch items, batch:true nodes,
    // workflow.fire fan-out). Overrides EXECUTION_MAX_ITERATIONS.
    maxIterations: { type: "integer", minimum: 1 },
    // Per-execution token budget (sum of agent inputTokens +
    // outputTokens). Overrides EXECUTION_MAX_TOKENS. 0 disables.
    maxTokens: { type: "integer", minimum: 0 },
    data: { type: "object", additionalProperties: true, default: {} },
    // Designer-time metadata: AI prompt history, declared inputs/outputs (docs),
    // and persisted node positions for the visual editor. Free-form so the UI
    // can extend it without schema bumps.
    meta: { type: "object", additionalProperties: true, default: {} },
    nodes: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["name", "action"],
        additionalProperties: false,
        properties: {
          name:        { type: "string", minLength: 1, pattern: "^[A-Za-z_][A-Za-z0-9_.-]*$" },
          action:      { type: "string", minLength: 1 },
          description: { type: "string" },
          // inputs/outputs accept either:
          //   object form:   { url: "${url}" }
          //   array form:    [ { url: "${url}" } ]      (per spec)
          inputs:      { oneOf: [
            { type: "object", additionalProperties: true },
            { type: "array",  items: { type: "object", additionalProperties: true } },
          ], default: {} },
          outputs:     { oneOf: [
            { type: "object", additionalProperties: { type: "string" } },
            { type: "array",  items: { type: "object", additionalProperties: { type: "string" } } },
          ], default: {} },
          executeIf:   { type: "string" },
          retry:       { type: "integer", minimum: 0, default: 0 },
          retryDelay:  { type: ["integer", "string"], default: 0 },
          // Per-node wall-clock budget. Wins over workflow-level
          // nodeTimeout, which wins over EXECUTION_DEFAULT_NODE_TIMEOUT.
          timeout:     { type: ["integer", "string"] },
          onError:     { type: "string", enum: ["continue", "terminate"], default: "terminate" },
          batch:       { type: "boolean", default: false },
          batchOver:   { type: "string" }, // expression resolving to an array
          // Optional ctx-variable name. When set, the engine writes the
          // plugin's "primary" output (or the whole output object if the
          // plugin doesn't declare one) to ctx[outputVar] after each run,
          // so downstream nodes can read it as ${<outputVar>} without an
          // explicit `outputs:` mapping.
          outputVar:   { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
        },
      },
    },
    edges: {
      type: "array",
      default: [],
      items: {
        type: "object",
        required: ["from", "to"],
        additionalProperties: false,
        properties: {
          from: { type: "string" },
          to:   { type: "string" },
        },
      },
    },
  },
};
