// NodeRegistry — built at runtime from the live action-plugin list.
//
// Each entry maps an action name (e.g. "http.request") to:
//   {
//     plugin:      <the raw plugin metadata from /plugins>,
//     propertyUI:  Vue component used to edit a selected node of this kind,
//     defaultNode: () => <a fresh VueFlow node object> ready for addNodes(),
//   }
//
// Used by the canvas tab as:
//
//   const registry = buildNodeRegistry(plugins)
//   addNodes(registry["http.request"].defaultNode())
//
// All actions share a single generic `propertyUI` (PluginPropertyPanel) and
// a single generic display node (`PluginNode`). Both are schema-driven —
// they read the plugin metadata from `node.data.plugin` to know which
// fields to render.
//
// We also register two special types for control-flow:
//   • "_start" → an entry node (no input handle, just out)
//   • "_end"   → an exit node  (no output handle)

import { Position } from "@vue-flow/core";
import PluginPropertyPanel from "./nodes/PluginPropertyPanel.vue";

/** Pull a sensible default value for a required input from its JSON-Schema entry. */
function defaultsFromSchema(schema) {
  if (!schema?.properties) return {};
  const out = {};
  for (const k of (schema.required || [])) {
    const def = schema.properties[k];
    if (def?.default !== undefined) out[k] = def.default;
    else if (def?.type === "string")  out[k] = "";
    else if (def?.type === "integer" || def?.type === "number") out[k] = 0;
    else if (def?.type === "boolean") out[k] = false;
    else                              out[k] = "";
  }
  return out;
}

/** Build a fresh VueFlow node object for a given plugin. */
function makeDefaultNode(plugin) {
  const id = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : `n-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const safeName = (plugin.name || "node").replace(/[^A-Za-z0-9_-]/g, "_");
  return {
    id,
    type: "plugin",
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    position: { x: 100 + Math.random() * 80, y: 60 + Math.random() * 80 },
    data: {
      action:      plugin.name,
      name:        safeName,
      description: plugin.description || "",
      inputs:      defaultsFromSchema(plugin.inputSchema),
      outputs:     {},
      executeIf:   "",
      retry:       0,
      retryDelay:  0,
      onError:     "terminate",
      batchOver:   "",
      // Reference kept on the node so the property panel + display
      // component can read schemas without a registry lookup.
      plugin,
    },
  };
}

export function buildNodeRegistry(plugins = []) {
  const registry = {};
  for (const plugin of plugins) {
    registry[plugin.name] = {
      plugin,
      propertyUI: PluginPropertyPanel,
      defaultNode: () => makeDefaultNode(plugin),
    };
  }
  return registry;
}
