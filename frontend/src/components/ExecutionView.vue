<script setup>
import { computed, ref } from "vue";
import GraphView from "./GraphView.vue";
import { useGraphsStore } from "../stores/graphs.js";
import BatchOutputTable from "./BatchOutputTable.vue";
import InputsTable from "./InputsTable.vue";
import NodesTable from "./NodesTable.vue";

const store = useGraphsStore();
const tab = computed(() => store.activeExecTab);

// Prefer the parsed DSL we cached on the execution tab itself (loaded eagerly
// in store.openExecution). Fall back to any open editor tab for the parent
// graph, then to a name-only synthesis from the engine's per-node summary.
const parsed = computed(() => {
  const t = tab.value;
  if (!t) return null;
  if (t.graphParsed) return t.graphParsed;
  const editor = store.tabs.find(x => x.kind === "graph" && x.graphId === t.graphId);
  if (editor?.parsed) return editor.parsed;
  const names = Object.keys(t.data?.context?.nodes || {});
  return names.length ? { nodes: names.map(n => ({ name: n, action: "" })), edges: [] } : null;
});

const status = computed(() => tab.value?.data?.status || "queued");
// Batch mode is detected from the user's input — array, or { items: [...] }.
// (After execution finishes, batch results live in `context.items`; we still
// fall back to that for older runs where inputs weren't stored separately.)
const userInputs = computed(() => {
  const d = tab.value?.data;
  if (!d) return null;
  // Prefer the dedicated `inputs` column; fall back to `context` for legacy rows.
  const v = d.inputs && (Array.isArray(d.inputs) || Object.keys(d.inputs).length > 0)
    ? d.inputs
    : d.context;
  return v ?? null;
});
const isBatch = computed(() => {
  const i = userInputs.value;
  return Array.isArray(i) || Array.isArray(i?.items)
      || Array.isArray(tab.value?.data?.context?.items);
});
const batchItems = computed(() => {
  if (!isBatch.value) return [];
  const i = userInputs.value;
  if (Array.isArray(i)) return i.map((item, index) => ({ index, status: "—", input: item }));
  if (Array.isArray(i?.items)) return i.items.map((item, index) => ({ index, status: "—", input: item }));
  // Final-context fallback: worker stored per-item results
  return tab.value.data.context.items;
});
const inputContext = computed(() => isBatch.value ? null : (userInputs.value || {}));
// The engine's per-node summary lives in execution.context.nodes.
const ctxNodes = computed(() => tab.value?.data?.context?.nodes || {});

// Rows for the inputs table — one row per top-level key in the user's JSON.
const inputRows = computed(() => {
  const i = inputContext.value;
  if (!i || typeof i !== "object") return [];
  return Object.entries(i).map(([k, v]) => ({ k, v }));
});






function fmt(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

const refreshing = ref(false);
async function onRefresh() {
  if (refreshing.value) return;
  refreshing.value = true;
  try { await store.refreshExecution(); }
  finally { refreshing.value = false; }
}
</script>

<template>
  <div v-if="!tab" class="col flex flex-center text-grey">No execution selected.</div>
  <div v-else class="col exec-view scroll">
    <q-toolbar dense class="q-py-xs bg-grey-12">
      <q-icon name="play_circle" size="18px" class="q-mr-sm" />
      <div class="text-subtitle2">Execution {{ tab.execId.slice(0, 8) }}…</div>
      <q-chip dense square :class="`status-${status}`" class="q-ml-sm">{{ status }}</q-chip>
      <q-chip v-if="isBatch" dense square color="grey-9" text-color="grey-3">
        batch · {{ batchItems.length }} items
      </q-chip>
      <q-space />
      <div v-if="tab.data?.started_at" class="text-caption text-grey q-mr-sm">
        started {{ new Date(tab.data.started_at).toLocaleString() }}
        <span v-if="tab.data.finished_at"> · ended {{ new Date(tab.data.finished_at).toLocaleString() }}</span>
      </div>
      <q-btn
        round outline color="primary" size="sm"
        icon="refresh"
        :loading="refreshing"
        @click="onRefresh"
      >
        <q-tooltip>Refresh</q-tooltip>
      </q-btn>
    </q-toolbar>

    <div class="exec-graph">
      <GraphView mode="exec" :parsed="parsed" :node-status="tab.nodeStatus" />
    </div>

      <q-expansion-item dense dense-toggle default-opened :label="isBatch ? 'Batch items' : 'Inputs' " header-class="bg-grey-11">
      <BatchOutputTable v-if="isBatch" :rows="batchItems"></BatchOutputTable>
      <InputsTable v-else :rows="inputRows"></InputsTable>
    </q-expansion-item>
 
    <q-expansion-item dense dense-toggle default-opened label="Nodes" header-class="bg-grey-11">
      <NodesTable :ctx-nodes="ctxNodes" />
    </q-expansion-item>

  </div>
</template>

<style scoped>
.exec-view {
  display: flex;
  flex-direction: column;
}

.exec-graph {
  height: 320px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--border);
}



.section-title {
  padding: 3px;
  font-size: 11px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  background-color: var(--q-color-grey-12);
}

.cell-pre {
  margin: 0;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 11.5px;
  white-space: pre-wrap;
  word-break: break-word;
  max-width: 600px;
}

.dense-table :deep(thead th) {
  font-size: 11px;
  color: var(--muted);
}

.dense-table :deep(tbody td) {
  font-size: 12px;
  vertical-align: top;
}
</style>
