<!--
  InstanceViewer — read-only view of a single execution.

  Reachable via /instanceViewer/:id (linked from FlowInspector).

  Layout (top → bottom):
    • Header           : back button, graph name + version, execution status,
                         live "refresh" while the run is still in flight.
    • DAG view         : <GraphView mode="exec"> with per-node statuses derived
                         from execution.context.nodes.<name>.status. Nothing
                         here is editable — wires + status overlay only.
    • Inputs           : either a flat key/value table (single run) or the
                         BatchOutputTable when the run is a batch.
    • Nodes            : NodesTable showing each node's status / output / error
                         from the engine's per-node summary.
-->
<template>
    <q-layout view="hHh lpR fFf">
        <q-header class="bg-grey-12">
            <q-toolbar>
                <q-btn flat round dense icon="arrow_back" class="text-black" @click="goBack">
                    <q-tooltip>Back</q-tooltip>
                </q-btn>
                <q-toolbar-title class="text-black">
                    <b>{{ headerTitle }}</b>
                    <span class="q-ml-sm text-caption text-grey-8">execution</span>
                </q-toolbar-title>
                <q-space />
                <q-chip v-if="status" dense square :class="`status-${status}`" class="q-mr-sm">
                    {{ status }}
                </q-chip>
                <q-btn
                    flat dense round icon="refresh" class="text-black"
                    :loading="refreshing"
                    @click="refresh"
                >
                    <q-tooltip>Refresh</q-tooltip>
                </q-btn>
            </q-toolbar>
        </q-header>

        <q-page-container>
            <q-page>
                <q-banner v-if="loadError" dense class="bg-red-10 text-red-2 q-mb-sm">
                    <template v-slot:avatar><q-icon name="error_outline" /></template>
                    {{ loadError }}
                </q-banner>

                <div v-if="loading" class="row flex-center q-pa-lg">
                    <q-spinner-dots color="primary" size="32px" />
                </div>

                <template v-else>
                    <!-- Read-only DAG with per-node status overlay ─────────── -->
                    <div class="exec-graph">
                        <GraphView mode="exec" :parsed="parsed" :node-status="nodeStatus" />
                    </div>

                    <q-separator />

                    <!-- Inputs / batch items ────────────────────────────────── -->
                    <q-expansion-item
                        dense dense-toggle default-opened
                        :label="isBatch ? 'Batch items' : 'Inputs'"
                        header-class="bg-grey-11"
                    >
                        <BatchOutputTable v-if="isBatch" :rows="batchItems" />
                        <InputsTable v-else :rows="inputRows" />
                    </q-expansion-item>

                    <!-- Nodes summary ───────────────────────────────────────── -->
                    <q-expansion-item dense dense-toggle default-opened label="Nodes" header-class="bg-grey-11">
                        <NodesTable :ctx-nodes="ctxNodes" />
                    </q-expansion-item>

                    <!-- Top-level error if the run failed before any node ran -->
                    <q-expansion-item
                        v-if="execution?.error"
                        dense dense-toggle default-opened
                        label="Error" header-class="bg-grey-11"
                    >
                        <pre class="cell-pre q-pa-md">{{ execution.error }}</pre>
                    </q-expansion-item>
                </template>
            </q-page>
        </q-page-container>
    </q-layout>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useQuasar } from "quasar";
import { Graphs, Executions } from "../api/client";
import { parseYamlToModel } from "../components/flow/flowModel.js";

import GraphView        from "../components/GraphView.vue";
import InputsTable      from "../components/InputsTable.vue";
import BatchOutputTable from "../components/BatchOutputTable.vue";
import NodesTable       from "../components/NodesTable.vue";

const route   = useRoute();
const router  = useRouter();
const $q      = useQuasar();

// ── State ──────────────────────────────────────────────────────────────────
const loading    = ref(true);
const refreshing = ref(false);
const loadError  = ref("");
const execution  = ref(null);   // raw row from /executions/:id
const graph      = ref(null);   // raw row from /graphs/:id (yaml + meta)
const parsed     = ref(null);   // { nodes, edges, ... } — for GraphView

// ── Derived ────────────────────────────────────────────────────────────────
const status = computed(() => execution.value?.status || "");

const headerTitle = computed(() => {
    if (graph.value?.name) {
        const v = graph.value.version ? ` v${graph.value.version}` : "";
        return `${graph.value.name}${v}`;
    }
    if (execution.value?.id) return execution.value.id.slice(0, 8) + "…";
    return "Execution";
});

// Engine's per-node summary lives on execution.context.nodes
const ctxNodes = computed(() => execution.value?.context?.nodes || {});

// nodeStatus map for GraphView: { [nodeName]: status }
const nodeStatus = computed(() => {
    const out = {};
    for (const [name, n] of Object.entries(ctxNodes.value)) {
        if (n?.status) out[name] = n.status;
    }
    return out;
});

// Batch detection — same logic as ExecutionView.
const userInputs = computed(() => {
    const d = execution.value;
    if (!d) return null;
    const v = d.inputs && (Array.isArray(d.inputs) || Object.keys(d.inputs).length > 0)
        ? d.inputs
        : d.context;
    return v ?? null;
});
const isBatch = computed(() => {
    const i = userInputs.value;
    return Array.isArray(i)
        || Array.isArray(i?.items)
        || Array.isArray(execution.value?.context?.items);
});
const batchItems = computed(() => {
    if (!isBatch.value) return [];
    const i = userInputs.value;
    if (Array.isArray(i)) return i.map((item, index) => ({ index, status: "—", input: item }));
    if (Array.isArray(i?.items)) return i.items.map((item, index) => ({ index, status: "—", input: item }));
    return execution.value?.context?.items || [];
});

const inputContext = computed(() => isBatch.value ? null : (userInputs.value || {}));
const inputRows = computed(() => {
    const i = inputContext.value;
    if (!i || typeof i !== "object") return [];
    return Object.entries(i).map(([k, v]) => ({ k, v }));
});

// ── Loaders ────────────────────────────────────────────────────────────────
async function loadExecution() {
    const id = route.params.id;
    if (!id) {
        loadError.value = "No execution id in route.";
        return;
    }
    try {
        const exec = await Executions.get(id);
        execution.value = exec;
        // Load the parent graph once; rely on its YAML for the DAG layout so
        // we get the same wires the author drew, even for nodes that never
        // actually ran.
        if (!graph.value || graph.value.id !== exec.graph_id) {
            try {
                const g = await Graphs.get(exec.graph_id);
                graph.value  = g;
                parsed.value = adaptModelToGraphView(parseYamlToModel(g.yaml));
            } catch (e) {
                // Graph deleted? Synthesize from the per-node summary so the
                // user still sees something.
                parsed.value = synthFromCtx(exec);
            }
        }
    } catch (e) {
        loadError.value = errMsg(e);
    }
}

/** Translate the visual editor's normalized model into the shape GraphView
 *  expects (which is { nodes: [{ name, action }], edges: [{ from, to }] }).
 *  Our `parseYamlToModel` already produces nodes with name/action/etc. and
 *  edges with from/to, so we can pass it almost directly. */
function adaptModelToGraphView(model) {
    return {
        nodes: (model.nodes || []).map(n => ({ name: n.name, action: n.action })),
        edges: (model.edges || []).map(e => ({ from: e.from, to: e.to })),
    };
}

/** Fallback when the parent graph row is missing: build a "names only"
 *  topology from execution.context.nodes so GraphView at least renders the
 *  set of nodes the engine touched. No edges (we don't know them). */
function synthFromCtx(exec) {
    const names = Object.keys(exec?.context?.nodes || {});
    if (!names.length) return null;
    return {
        nodes: names.map(n => ({ name: n, action: "" })),
        edges: [],
    };
}

// ── Lifecycle ──────────────────────────────────────────────────────────────
onMounted(async () => {
    await loadExecution();
    loading.value = false;
});

// Auto-poll while the run is still in flight (queued/running). Stops once
// it lands in a terminal state. Saves the user from clicking refresh while
// watching a slow workflow.
let pollTimer = null;
function startPolling() { stopPolling(); pollTimer = setInterval(loadExecution, 2500); }
function stopPolling()  { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

watch(status, (s) => {
    if (s === "queued" || s === "running") startPolling();
    else stopPolling();
}, { immediate: false });

onBeforeUnmount(stopPolling);

async function refresh() {
    if (refreshing.value) return;
    refreshing.value = true;
    try { await loadExecution(); }
    finally { refreshing.value = false; }
}

function goBack() {
    if (window.history.length > 1) router.back();
    else router.push("/flowInspector");
}

function errMsg(e) { return e?.response?.data?.message || e?.message || "unknown error"; }
</script>

<style scoped>
.exec-graph {
    height: 360px;
    border-bottom: 1px solid var(--border, #2a3142);
}
.cell-pre {
    margin: 0;
    font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: 12px;
    white-space: pre-wrap;
    word-break: break-word;
}
.status-running  { background: rgba( 79,140,255,0.15); color: #4f8cff; }
.status-queued   { background: rgba(245,166, 35,0.15); color: #f5a623; }
.status-success  { background: rgba( 46,204,113,0.15); color: #2ecc71; }
.status-failed   { background: rgba(255, 90, 95,0.15); color: #ff5a5f; }
.status-skipped  { background: rgba(128,128,128,0.15); color: #888;   }
</style>
