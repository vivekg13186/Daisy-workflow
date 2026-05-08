<!--
  Canvas tab — VueFlow-based, drawer layout (modeled after the user's
  WorkflowEditor.vue reference).

  Why this design fixes the "screen reload every time / plugin click broken"
  issue from the previous iteration:
    • The canvas state (nodes/edges) lives in LOCAL refs that we manage via
      useVueFlow() helpers (addNodes, updateNode, fromObject/toObject).
    • The parent flow model is NOT reactively bound to the canvas. We sync
      one-way at well-defined moments: model → canvas on mount and whenever
      the parent replaces the model (import / AI generate); canvas → model
      via debounced extracts.
    • Adding a plugin from the palette is a single addNodes() call — no
      :nodes prop round-trip, so no recursive update loop.
-->
<template>
  <div class="canvas-tab row no-wrap full-height">

    <!-- ── Left: plugin palette ─────────────────────────────────────── -->
    <div v-if="leftOpen" class="left-pane column no-wrap" style="width: 260px;">
      <NodePalette :plugins="plugins" @add="onAddPlugin" />
    </div>

    <!-- ── Center: VueFlow canvas ───────────────────────────────────── -->
    <div class="flow-container col">
      <VueFlow
        v-model:nodes="nodes"
        v-model:edges="edges"
        class="fit"
        :default-viewport="{ x: 0, y: 0, zoom: 1 }"
        @node-click="onNodeClick"
        @pane-click="onPaneClick"
      >
        <Background />
        <Controls>
          <ControlButton @click="leftOpen = !leftOpen">
            <q-icon name="build">
              <q-tooltip anchor="center right" self="center left" :offset="[10, 10]">
                Toggle plugin palette
              </q-tooltip>
            </q-icon>
          </ControlButton>
          <ControlButton @click="rightOpen = !rightOpen">
            <q-icon name="settings">
              <q-tooltip anchor="center right" self="center left" :offset="[10, 10]">
                Toggle property panel
              </q-tooltip>
            </q-icon>
          </ControlButton>
        </Controls>
        <MiniMap pannable zoomable />

        <template #node-plugin="props">
          <PluginNode v-bind="props" />
        </template>
      </VueFlow>
    </div>

    <!-- ── Right: properties + per-node toolbar ─────────────────────── -->
    <div v-if="rightOpen" class="right-pane column no-wrap" style="width: 360px;">
      <q-toolbar dense class="bg-grey-12">
        <span class="text-caption text-grey">{{ selectedNode ? "Node" : "Flow" }} properties</span>
        <q-space />
        <q-btn v-if="selectedNode" dense flat round icon="delete" color="negative" size="sm"
               @click="onDeleteSelected">
          <q-tooltip>Delete selected node</q-tooltip>
        </q-btn>
        <q-btn dense flat round icon="close" size="sm" @click="rightOpen = false">
          <q-tooltip>Hide panel</q-tooltip>
        </q-btn>
      </q-toolbar>

      <q-scroll-area class="col">
        <component
          v-if="selectedNode"
          :is="PluginPropertyPanel"
          :node="selectedNode"
          @update="onUpdateNodeData"
        />
        <div v-else class="q-pa-md text-caption text-grey">
          Click a node on the canvas to edit its properties, or pick a plugin from
          the left palette to add one.
        </div>
      </q-scroll-area>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, computed, onMounted, onBeforeUnmount, nextTick } from "vue";
import "@vue-flow/core/dist/style.css";
import "@vue-flow/core/dist/theme-default.css";
import "@vue-flow/controls/dist/style.css";
import "@vue-flow/minimap/dist/style.css";

import { VueFlow, useVueFlow, Position } from "@vue-flow/core";
import { Background } from "@vue-flow/background";
import { Controls, ControlButton } from "@vue-flow/controls";
import { MiniMap } from "@vue-flow/minimap";

import NodePalette          from "./NodePalette.vue";
import PluginNode           from "./nodes/PluginNode.vue";
import PluginPropertyPanel  from "./nodes/PluginPropertyPanel.vue";
import { buildNodeRegistry } from "./NodeRegistry.js";

const props = defineProps({
  modelValue: { type: Object, required: true },
  plugins:    { type: Array,  default: () => [] },
});
const emit = defineEmits(["update:modelValue"]);

// ── Drawer toggles ──────────────────────────────────────────────────────────
const leftOpen  = ref(true);
const rightOpen = ref(false);

// ── VueFlow store ───────────────────────────────────────────────────────────
const nodes = ref([]);
const edges = ref([]);

// useVueFlow gives us imperative helpers that work against the canvas state
// without going through the :nodes/:edges props (which would loop us back
// into the parent's model).
const { addNodes, addEdges, updateNode, onConnect } = useVueFlow();

// Auto-add edges when the user drags a connection between two handles.
onConnect((connection) => {
  // Avoid duplicates.
  const dup = edges.value.find(e => e.source === connection.source && e.target === connection.target);
  if (dup) return;
  addEdges([{
    id: `e-${connection.source}-${connection.target}-${Date.now()}`,
    source: connection.source,
    target: connection.target,
  }]);
  scheduleExtract();
});

// ── Node registry ───────────────────────────────────────────────────────────
const registry = computed(() => buildNodeRegistry(props.plugins));

// ── Selection ───────────────────────────────────────────────────────────────
const selectedNodeId = ref(null);
const selectedNode = computed(() =>
  selectedNodeId.value ? nodes.value.find(n => n.id === selectedNodeId.value) || null : null
);

function onNodeClick({ node }) {
  selectedNodeId.value = node.id;
  rightOpen.value = true;
}
function onPaneClick() {
  selectedNodeId.value = null;
}

// ── Palette → addNodes ──────────────────────────────────────────────────────
function onAddPlugin(plugin) {
  const entry = registry.value[plugin.name];
  if (!entry) return;
  const node = entry.defaultNode();
  // Pick a unique on-screen name based on the action.
  const taken = new Set(nodes.value.map(n => n.data?.name).filter(Boolean));
  if (taken.has(node.data.name)) {
    let i = 2;
    while (taken.has(`${node.data.name}-${i}`)) i++;
    node.data.name = `${node.data.name}-${i}`;
  }
  addNodes([node]);
  selectedNodeId.value = node.id;
  rightOpen.value = true;
  scheduleExtract();
}

// ── Property panel updates → updateNode ─────────────────────────────────────
function onUpdateNodeData(newData) {
  if (!selectedNode.value) return;
  updateNode(selectedNode.value.id, { data: { ...selectedNode.value.data, ...newData } });
  scheduleExtract();
}

function onDeleteSelected() {
  if (!selectedNodeId.value) return;
  const id = selectedNodeId.value;
  nodes.value = nodes.value.filter(n => n.id !== id);
  edges.value = edges.value.filter(e => e.source !== id && e.target !== id);
  selectedNodeId.value = null;
  scheduleExtract();
}

// ── Sync model → canvas ────────────────────────────────────────────────────
//
// We do this once on mount and again whenever the parent replaces the model
// (import / AI generate). The watcher uses identity equality so editing a
// field inside the model (which doesn't change the model reference) doesn't
// trigger a re-import — only outright replacement does.
let suspendExtract = false;
function applyModel(model) {
  suspendExtract = true;
  // Convert flow model to VueFlow nodes/edges.
  const nameToId = new Map();
  const newNodes = (model.nodes || []).map((n, i) => {
    const plugin = (props.plugins || []).find(p => p.name === n.action) || { name: n.action, inputSchema: {}, outputSchema: {} };
    const pos = model.meta?.positions?.[n.name] || { x: 100 + (i % 4) * 220, y: 60 + Math.floor(i / 4) * 120 };
    const id  = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : `n-${Date.now()}-${i}`;
    nameToId.set(n.name, id);
    return {
      id,
      type: "plugin",
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      position: { x: pos.x, y: pos.y },
      data: {
        action:      n.action,
        name:        n.name,
        description: n.description || "",
        inputs:      { ...(n.inputs  || {}) },
        outputs:     { ...(n.outputs || {}) },
        executeIf:   n.executeIf  || "",
        retry:       n.retry      || 0,
        retryDelay:  n.retryDelay || 0,
        onError:     n.onError    || "terminate",
        batchOver:   n.batchOver  || "",
        plugin,
      },
    };
  });
  const newEdges = (model.edges || []).map((e, i) => ({
    id: `e-${i}-${e.from}-${e.to}`,
    source: nameToId.get(e.from) || e.from,
    target: nameToId.get(e.to)   || e.to,
  }));

  nodes.value = newNodes;
  edges.value = newEdges;
  selectedNodeId.value = null;
  // Release after the canvas processes the new arrays.
  nextTick().then(() => { suspendExtract = false; });
}

// ── Sync canvas → model (debounced) ────────────────────────────────────────
let extractTimer = null;
function scheduleExtract() {
  if (suspendExtract) return;
  if (extractTimer) clearTimeout(extractTimer);
  extractTimer = setTimeout(() => {
    extractTimer = null;
    extractAndEmit();
  }, 200);
}

function extractAndEmit() {
  // Build the canvas-side patch of model.
  const idToName = new Map();
  const positions = {};
  const out = {};
  const newNodes = nodes.value.map(n => {
    const dagName = (n.data?.name || `node-${n.id}`).trim();
    idToName.set(n.id, dagName);
    positions[dagName] = {
      x: Math.round(n.position?.x ?? 0),
      y: Math.round(n.position?.y ?? 0),
    };
    return {
      name:        dagName,
      action:      n.data?.action || "",
      description: n.data?.description || "",
      inputs:      n.data?.inputs  || {},
      outputs:     n.data?.outputs || {},
      executeIf:   n.data?.executeIf  || "",
      retry:       n.data?.retry      || 0,
      retryDelay:  n.data?.retryDelay || 0,
      onError:     n.data?.onError    || "terminate",
      batchOver:   n.data?.batchOver  || "",
    };
  });
  const newEdges = edges.value
    .map(e => ({ from: idToName.get(e.source), to: idToName.get(e.target) }))
    .filter(e => e.from && e.to);

  emit("update:modelValue", {
    ...props.modelValue,
    nodes: newNodes,
    edges: newEdges,
    meta: { ...(props.modelValue.meta || {}), positions },
  });
}

// Track outright model replacement (import / AI generate / route change).
// We compare by reference — fields inside the same object don't trigger this.
let lastSeenModelRef = null;
watch(() => props.modelValue, (m) => {
  if (m === lastSeenModelRef) return;
  lastSeenModelRef = m;
  // Only reapply when the new model is structurally different from what's on
  // the canvas right now (a no-op when WE were the source of the change).
  const sameNodeCount = (m.nodes?.length || 0) === nodes.value.length;
  if (sameNodeCount && nodes.value.length > 0) {
    // assume our local state is already authoritative — skip re-importing
    return;
  }
  applyModel(m);
}, { immediate: true });

onBeforeUnmount(() => {
  if (extractTimer) clearTimeout(extractTimer);
});
</script>

<style scoped>
.canvas-tab    { width: 100%; height: 100%; }
.flow-container{ flex: 1 1 auto; min-width: 0; height: 100%; position: relative; }
.left-pane     {  border-right: 1px solid var(--border); }
.right-pane    { border-left:  1px solid var(--border); }
</style>
