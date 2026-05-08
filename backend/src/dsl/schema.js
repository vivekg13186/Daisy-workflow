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
          onError:     { type: "string", enum: ["continue", "terminate"], default: "terminate" },
          batch:       { type: "boolean", default: false },
          batchOver:   { type: "string" }, // expression resolving to an array
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
