<!--
  Generic VueFlow custom node used for every action plugin. Rendered when
  the parent's <VueFlow> sees node.type === "plugin". Reads node.data
  (set up by NodeRegistry.makeDefaultNode) to draw the card.
-->
<template>
  <div class="plugin-node" :class="{ selected }">
    <Handle type="target" :position="Position.Left" />
    <div class="row items-center no-wrap">
      <q-icon :name="iconForAction(data.action)" size="14px" class="q-mr-xs" />
      <div class="col">
        <div class="node-name ellipsis">{{ data.name || "(unnamed)" }}</div>
        <div class="node-action ellipsis">{{ data.action }}</div>
      </div>
    </div>
    <Handle type="source" :position="Position.Right" />
  </div>
</template>

<script setup>
import { Handle, Position } from "@vue-flow/core";

defineProps({
  id:       { type: String, required: true },
  data:     { type: Object, required: true },
  selected: { type: Boolean, default: false },
});

// Pick a vaguely appropriate Material icon for each action prefix.
const ICONS = {
  http:    "language",
  web:     "public",
  sql:     "storage",
  email:   "mail_outline",
  file:    "description",
  csv:     "table_view",
  excel:   "grid_on",
  log:     "terminal",
  delay:   "timer",
  transform: "transform",
  condition: "rule",
  default: "extension",
};
function iconForAction(action) {
  if (!action) return ICONS.default;
  const prefix = action.split(".")[0];
  return ICONS[prefix] || ICONS[action] || ICONS.default;
}
</script>

<style scoped>
.plugin-node {
  background: #fff ;
  color: #1d2230;
  border: 1px solid #c6c6c6;
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 11px;
  width: 180px;
  box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 2px 6px rgba(0,0,0,0.4);
}
.plugin-node.selected {
  border-color: #4f8cff;
  box-shadow: 0 0 0 2px rgba(79,140,255,0.25);
}
.node-name   { font-weight: 600; }
.node-action { font-size: 10.5px; color: #8b93a7; }
</style>
