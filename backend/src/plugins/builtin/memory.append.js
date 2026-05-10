// memory.append — append an item to a JSON array stored under a single
// memory key. If the key doesn't exist (or its value isn't an array),
// the row is initialised as [item].
//
// Race note: this is a read-then-write, so two parallel appends to the
// same key may race. Fine for typical event-log use cases; for heavy
// concurrency, prefer the conversation-history plugin (one row per
// turn, monotonic seq).

import { appendKv } from "../../engine/memoryStore.js";

export default {
  name: "memory.append",
  description:
    "Append an item to a JSON array stored under a memory key. " +
    "Useful for event logs, accumulating audit trails, etc.",

  inputSchema: {
    type: "object",
    required: ["key"],
    properties: {
      key:       { type: "string", title: "Key", minLength: 1 },
      item:      { title: "Item",      placeholder: "${event}" },
      namespace: { type: "string", title: "Namespace", default: "kv" },
    },
  },

  primaryOutput: "length",

  outputSchema: {
    type: "object",
    properties: {
      key:    { type: "string" },
      length: { type: "integer", description: "Total items in the list after the append." },
    },
  },

  async execute(input, ctx) {
    const length = await appendKv({
      workspaceId: ctx?.execution?.workspaceId,
      scope:       "workflow",
      scopeId:     ctx?.execution?.graphId || null,
      namespace:   input.namespace || "kv",
      key:         input.key,
      item:        input.item ?? null,
    });
    return { key: input.key, length };
  },
};
