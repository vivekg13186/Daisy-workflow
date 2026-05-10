// memory.set — write/update a value in the workflow's memory store.
// Subsequent runs see the value via ${memory.<key>}.

import { setKv } from "../../engine/memoryStore.js";

export default {
  name: "memory.set",
  description:
    "Store a value in workflow memory. Persists across runs. Read " +
    "back via ${memory.<key>} or the memory.get plugin.",

  inputSchema: {
    type: "object",
    required: ["key"],
    properties: {
      key:       { type: "string", title: "Key", minLength: 1 },
      // type-less so the property panel renders a plain text input
      // and the user types either a literal or a ${var} reference
      // resolving to whatever shape they want stored.
      value:     { title: "Value", placeholder: "${someVar}" },
      namespace: { type: "string", title: "Namespace", default: "kv" },
    },
  },

  primaryOutput: "key",

  outputSchema: {
    type: "object",
    properties: {
      key:   { type: "string" },
      value: { description: "Echo of what was stored." },
    },
  },

  async execute(input, ctx) {
    // value=undefined → store JSON null, so the row exists but reads back as null.
    const value = input.value === undefined ? null : input.value;
    await setKv({
      workspaceId: ctx?.execution?.workspaceId,
      scope:       "workflow",
      scopeId:     ctx?.execution?.graphId || null,
      namespace:   input.namespace || "kv",
      key:         input.key,
      value,
    });
    return { key: input.key, value };
  },
};
