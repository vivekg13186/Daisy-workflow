<!--
  InstanceViewer — read-only view of a single execution.

  Reachable via /instanceViewer/:id (linked from FlowInspector).

  Layout (top → bottom):
    • Header           : back button, graph name, execution status,
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
        <q-header class="app-header">
            <q-toolbar class="app-toolbar">
            
                <q-btn flat round dense icon="arrow_back" class="btn-toolbar q-mr-sm" @click="goBack">
                    <q-tooltip>Back</q-tooltip>
                </q-btn>
                <q-toolbar-title>
                    {{ headerTitle }}
                    <span class="app-subtitle">execution</span>
                </q-toolbar-title>
                <q-space />
                <span v-if="status" class="status-pill q-mr-sm" :class="`status-${status}`">
                    {{ status }}
                </span>
                <q-btn
                    flat round dense
                    icon="refresh"
                    class="btn-icon"
                    :loading="refreshing"
                    @click="refresh"
                >
                    <q-tooltip>Refresh</q-tooltip>
                </q-btn>
            </q-toolbar>
        </q-header>

        <q-page-container>
            <q-page class="app-page">
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
                        header-class="app-section-header"
                    >
                        <BatchOutputTable v-if="isBatch" :rows="batchItems" />
                        <InputsTable v-else :rows="inputRows" />
                    </q-expansion-item>

                    <!-- Awaiting-response panel — one card per waiting
                         `user` node. Each card shows the prompt and a
                         JSON form; submitting POSTs the response and
                         resumes the execution. -->
                    <q-expansion-item
                        v-if="waitingNodes.length"
                        dense dense-toggle default-opened
                        label="Awaiting response"
                        header-class="app-section-header"
                    >
                        <div class="q-pa-md column q-gutter-md">
                            <div
                                v-for="n in waitingNodes" :key="n.node_name"
                                class="awaiting-card"
                            >
                                <div class="row items-center q-mb-sm">
                                    <q-icon name="schedule" class="q-mr-xs" />
                                    <code class="recovery-name">{{ n.node_name }}</code>
                                    <q-space />
                                    <span class="text-caption" style="color: var(--text-muted);">
                                        POST /executions/{{ execution?.id?.slice(0, 8) }}…/nodes/{{ n.node_name }}/respond
                                    </span>
                                </div>
                                <div v-if="n.output?.prompt" class="awaiting-prompt q-mb-sm">
                                    {{ n.output.prompt }}
                                </div>
                                <div v-if="n.output?.schema" class="text-caption q-mb-xs" style="color: var(--text-muted);">
                                    Expected response shape:
                                </div>
                                <pre v-if="n.output?.schema" class="awaiting-schema">{{ JSON.stringify(n.output.schema, null, 2) }}</pre>
                                <q-input
                                    :model-value="respondDrafts[n.node_name] ?? ''"
                                    @update:model-value="respondDrafts[n.node_name] = $event"
                                    type="textarea"
                                    outlined dense
                                    autogrow
                                    label="Response (JSON)"
                                    :error="!!respondErrs[n.node_name]"
                                    :error-message="respondErrs[n.node_name]"
                                    input-style="font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12.5px; min-height: 120px;"
                                />
                                <div class="row q-mt-sm">
                                    <q-space />
                                    <q-btn
                                        unelevated dense no-caps
                                        color="primary"
                                        icon="send"
                                        label="Submit response"
                                        :loading="busy === n.node_name + ':respond'"
                                        @click="onRespond(n.node_name)"
                                    />
                                </div>
                            </div>
                        </div>
                    </q-expansion-item>

                    <!-- Recovery panel — only shown when the run failed and
                         at least one node has a failed durable state row. -->
                    <q-expansion-item
                        v-if="failedNodes.length"
                        dense dense-toggle default-opened
                        label="Recovery"
                        header-class="app-section-header"
                    >
                        <div class="q-pa-md">
                            <div class="text-caption q-mb-sm" style="color: var(--text-muted);">
                                {{ failedNodes.length }} node(s) failed. Resume re-runs the selected
                                node (and any cascaded skipped descendants) using the same upstream
                                outputs. Edit lets you change the failed node's inputs first. Skip
                                marks the node skipped and continues with the rest of the workflow.
                            </div>
                            <q-list dense bordered separator class="recovery-list">
                                <q-item v-for="n in failedNodes" :key="n.node_name">
                                    <q-item-section>
                                        <q-item-label class="row items-center">
                                            <span class="status-pill status-failed q-mr-sm">failed</span>
                                            <code class="recovery-name">{{ n.node_name }}</code>
                                        </q-item-label>
                                        <q-item-label v-if="n.error" caption class="recovery-err">
                                            {{ n.error }}
                                        </q-item-label>
                                    </q-item-section>
                                    <q-item-section side>
                                        <div class="row q-gutter-xs">
                                            <q-btn
                                                size="sm" dense unelevated no-caps
                                                color="primary"
                                                icon="play_arrow"
                                                label="Resume"
                                                :loading="busy === n.node_name + ':resume'"
                                                @click="onResume(n.node_name)"
                                            />
                                            <q-btn
                                                size="sm" dense flat no-caps
                                                icon="edit"
                                                label="Edit & resume"
                                                :loading="busy === n.node_name + ':edit'"
                                                @click="onEdit(n)"
                                            />
                                            <q-btn
                                                size="sm" dense flat no-caps
                                                color="warning"
                                                icon="redo"
                                                label="Skip"
                                                :loading="busy === n.node_name + ':skip'"
                                                @click="onSkip(n.node_name)"
                                            />
                                        </div>
                                    </q-item-section>
                                </q-item>
                            </q-list>
                        </div>
                    </q-expansion-item>

                    <!-- Nodes summary ───────────────────────────────────────── -->
                    <q-expansion-item dense dense-toggle default-opened label="Nodes" header-class="app-section-header">
                        <NodesTable :ctx-nodes="ctxNodes" />
                    </q-expansion-item>

                    <!-- Top-level error if the run failed before any node ran -->
                    <q-expansion-item
                        v-if="execution?.error"
                        dense dense-toggle default-opened
                        label="Error" header-class="app-section-header"
                    >
                        <pre class="cell-pre q-pa-md">{{ execution.error }}</pre>
                    </q-expansion-item>
                </template>
            </q-page>
        </q-page-container>

        <!-- Edit-inputs dialog — opened by "Edit & resume" on a failed node.
             The user mutates the JSON the plugin saw on its last attempt;
             on Apply we POST /executions/:id/resume with `inputs` set, which
             tells the engine to bypass ${...} resolution for that node and
             use this object verbatim. -->
        <q-dialog v-model="editOpen" persistent>
            <q-card class="edit-card">
                <q-card-section class="q-pb-none">
                    <div class="text-h6">
                        Edit inputs for <code>{{ editing?.node_name }}</code>
                    </div>
                    <div class="text-caption" style="color: var(--text-muted);">
                        These were the resolved inputs the plugin saw on its last (failing)
                        attempt. Changes are applied verbatim — the engine won't re-resolve
                        <code>${ }</code> placeholders for this node when it resumes.
                    </div>
                </q-card-section>
                <q-card-section>
                    <q-input
                        v-model="editJson"
                        type="textarea"
                        outlined dense
                        autogrow
                        :error="!!editJsonErr"
                        :error-message="editJsonErr"
                        input-style="font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12.5px; min-height: 220px;"
                    />
                </q-card-section>
                <q-card-actions align="right">
                    <q-btn flat no-caps label="Cancel" v-close-popup />
                    <q-btn
                        unelevated no-caps
                        color="primary"
                        label="Apply & resume"
                        :loading="busy === editing?.node_name + ':edit'"
                        @click="onApplyEdit"
                    />
                </q-card-actions>
            </q-card>
        </q-dialog>
    </q-layout>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useQuasar } from "quasar";
import { Graphs, Executions } from "../api/client";
import { parseDslToModel } from "../components/flow/flowModel.js";

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
const execution  = ref(null);   // raw row from /executions/:id (now includes node_states)
const graph      = ref(null);   // raw row from /graphs/:id (yaml + meta)
const parsed     = ref(null);   // { nodes, edges, ... } — for GraphView

// Resume / skip / edit machinery
const busy       = ref("");                  // "<nodeName>:<action>" while a request is in flight
const editOpen   = ref(false);
const editing    = ref(null);                // the failed node currently being edited
const editJson   = ref("");
const editJsonErr = ref("");

// One per waiting `user` node — keys are node names, values are the
// in-progress JSON text the operator is typing in the textarea.
const respondDrafts = reactive({});
const respondErrs   = reactive({});

// ── Derived ────────────────────────────────────────────────────────────────
const status = computed(() => execution.value?.status || "");

// Workflows are single-row (no `version` column any more) — the header
// is just the graph name.
const headerTitle = computed(() => {
    if (graph.value?.name) return graph.value.name;
    if (execution.value?.id) return execution.value.id.slice(0, 8) + "…";
    return "Execution";
});

// Engine's per-node summary lives on execution.context.nodes after the run
// completes; per-node DURABLE state is on execution.node_states (written
// incrementally during the run and used by resume/skip).
const ctxNodes = computed(() => execution.value?.context?.nodes || {});

// Waiting-node list — one card per WAITING `user` plugin row.
// Each row's output carries the prompt + (optional) schema the
// plugin emitted, so we can render them in the response form.
const waitingNodes = computed(() => {
    const states = execution.value?.node_states || [];
    return states.filter(n => n.status === "waiting");
});

// Failed-node list driving the Recovery panel. Prefer the durable
// node_states rows (they include resolved_inputs for "Edit & resume");
// fall back to context.nodes for legacy runs that finished before
// durable execution shipped — those still get Resume / Skip but the
// edit dialog starts from the original ${...} inputs rather than the
// resolved ones.
const failedNodes = computed(() => {
    const states = execution.value?.node_states || [];
    if (states.length) return states.filter(n => n.status === "failed");
    return Object.entries(ctxNodes.value)
        .filter(([, n]) => n?.status === "failed")
        .map(([name, n]) => ({
            node_name:       name,
            status:          "failed",
            error:           n.error,
            resolved_inputs: null,
            attempts:        n.attempts,
            started_at:      n.startedAt,
            finished_at:     n.finishedAt,
        }));
});

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
                parsed.value = adaptModelToGraphView(parseDslToModel(g.dsl));
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
 *  Our `parseDslToModel` already produces nodes with name/action/etc. and
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

// Poll while the run is in flight OR paused waiting for a response —
// the response can arrive from outside the UI (e.g. a webhook caller),
// in which case the InstanceViewer should pick up the resumed status
// without a manual refresh.
watch(status, (s) => {
    if (s === "queued" || s === "running" || s === "waiting") startPolling();
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

// ── Resume / skip / edit ──────────────────────────────────────────────────

async function onResume(nodeName) {
    busy.value = `${nodeName}:resume`;
    try {
        await Executions.resume(route.params.id, { node: nodeName });
        $q.notify({ type: "positive", message: `Resumed from ${nodeName}`, position: "bottom" });
        // Polling kicks in automatically once status flips to queued/running.
        await loadExecution();
    } catch (e) {
        $q.notify({ type: "negative", message: `Resume failed: ${errMsg(e)}`, position: "bottom" });
    } finally {
        busy.value = "";
    }
}

async function onSkip(nodeName) {
    const ok = await new Promise((resolve) => {
        $q.dialog({
            title:   "Skip failed node?",
            message: `Marks "${nodeName}" as skipped. Descendants reachable only through this node will cascade to skipped on resume. Continue?`,
            ok:      { label: "Skip & resume", color: "warning", unelevated: true, "no-caps": true },
            cancel:  { label: "Cancel", flat: true, "no-caps": true },
            persistent: true,
        }).onOk(() => resolve(true)).onDismiss(() => resolve(false));
    });
    if (!ok) return;

    busy.value = `${nodeName}:skip`;
    try {
        await Executions.skip(route.params.id, nodeName);
        $q.notify({ type: "positive", message: `Skipped ${nodeName}`, position: "bottom" });
        await loadExecution();
    } catch (e) {
        $q.notify({ type: "negative", message: `Skip failed: ${errMsg(e)}`, position: "bottom" });
    } finally {
        busy.value = "";
    }
}

function onEdit(nodeRow) {
    editing.value = nodeRow;
    // Seed the editor with the most useful starting point we have:
    //   1. node_states.resolved_inputs — the actual values the plugin saw
    //      on its last (failing) attempt. Best case; available for runs
    //      that went through the durable-execution hook.
    //   2. The node's unresolved DSL inputs (e.g. {"url": "${url}"}) —
    //      visible in `parsed.value.nodes[]`. Useful for legacy runs that
    //      have no resolved_inputs row, or for nodes that failed during
    //      input resolution itself (so no resolved value was ever captured).
    //   3. Empty object — last resort.
    const resolved = nodeRow?.resolved_inputs;
    let seed;
    if (resolved && typeof resolved === "object") {
        seed = resolved;
    } else {
        const dslNode = (graph.value && parseDslToModel(graph.value.dsl).nodes || [])
            .find(n => n.name === nodeRow.node_name);
        seed = dslNode?.inputs && Object.keys(dslNode.inputs).length
            ? dslNode.inputs
            : {};
    }
    try { editJson.value = JSON.stringify(seed, null, 2); }
    catch { editJson.value = "{}"; }
    editJsonErr.value = "";
    editOpen.value = true;
}

async function onRespond(nodeName) {
    const raw = (respondDrafts[nodeName] ?? "").trim();
    let parsed;
    if (!raw) {
        parsed = {};
    } else {
        try { parsed = JSON.parse(raw); }
        catch (e) {
            respondErrs[nodeName] = `Invalid JSON: ${e.message}`;
            return;
        }
    }
    respondErrs[nodeName] = "";
    busy.value = `${nodeName}:respond`;
    try {
        await Executions.respond(route.params.id, nodeName, parsed);
        $q.notify({
            type: "positive",
            message: `Response submitted to ${nodeName}; resuming execution`,
            position: "bottom",
        });
        respondDrafts[nodeName] = "";
        await loadExecution();
    } catch (e) {
        respondErrs[nodeName] = errMsg(e);
    } finally {
        busy.value = "";
    }
}

async function onApplyEdit() {
    if (!editing.value) return;
    let parsedInputs;
    try { parsedInputs = JSON.parse(editJson.value || "{}"); }
    catch (e) {
        editJsonErr.value = `Invalid JSON: ${e.message}`;
        return;
    }
    if (parsedInputs === null || typeof parsedInputs !== "object" || Array.isArray(parsedInputs)) {
        editJsonErr.value = "Inputs must be a JSON object.";
        return;
    }
    const nodeName = editing.value.node_name;
    busy.value = `${nodeName}:edit`;
    try {
        await Executions.resume(route.params.id, { node: nodeName, inputs: parsedInputs });
        $q.notify({ type: "positive", message: `Resumed ${nodeName} with edited inputs`, position: "bottom" });
        editOpen.value = false;
        editing.value  = null;
        await loadExecution();
    } catch (e) {
        editJsonErr.value = errMsg(e);
    } finally {
        busy.value = "";
    }
}

function errMsg(e) { return e?.response?.data?.message || e?.message || "unknown error"; }
</script>

<style scoped>
.exec-graph {
    height: 360px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-sm);
    overflow: hidden;
    margin-bottom: 12px;
}

/* Recovery panel — list of failed nodes with action buttons */
.recovery-list { background: var(--surface); }
.recovery-name {
    background: rgba(0,0,0,0.06);
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 12.5px;
    font-family: ui-monospace, Menlo, Consolas, monospace;
}
.recovery-err {
    color: var(--danger);
    font-family: ui-monospace, Menlo, Consolas, monospace;
    word-break: break-word;
}

/* Edit-inputs dialog */
.edit-card {
    width: 720px;
    max-width: 92vw;
    background: var(--surface);
}

/* Awaiting-response cards — one per WAITING user node */
.awaiting-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-left: 3px solid var(--primary);
    border-radius: 6px;
    padding: 12px 14px;
}
.awaiting-prompt {
    color: var(--text);
    white-space: pre-wrap;
    line-height: 1.45;
}
.awaiting-schema {
    margin: 0 0 8px;
    padding: 8px 10px;
    background: rgba(0,0,0,0.06);
    border-radius: 4px;
    font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: 12px;
    overflow-x: auto;
}

/* status pills + cell-pre come from the global stylesheet */
</style>
