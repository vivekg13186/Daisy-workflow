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

                    <!-- Live output panel — populated from WS node:stream
                         events. Shows up while the run is active or as
                         long as any node has streamed something. Wipes
                         clean on a fresh execution load. -->
                    <q-expansion-item
                        v-if="hasStreamOutput"
                        dense dense-toggle default-opened
                        label="Live output"
                        header-class="app-section-header"
                    >
                        <div class="q-pa-md column q-gutter-md">
                            <div
                                v-for="(buf, name) in streamBuffers" :key="name"
                                class="stream-card"
                            >
                                <div class="row items-center q-mb-xs">
                                    <code class="recovery-name">{{ name }}</code>
                                    <q-space />
                                    <span class="text-caption" style="color: var(--text-muted);">
                                        {{ buf.text.length.toLocaleString() }} char(s)
                                    </span>
                                </div>
                                <pre class="stream-text">{{ buf.text }}<span v-if="liveStatuses[name] === 'running'" class="cursor-blink">▍</span></pre>
                                <div v-if="buf.logs.length" class="stream-logs">
                                    <div
                                        v-for="(l, i) in buf.logs" :key="i"
                                        :class="['stream-log', `stream-log-${l.level}`]"
                                    >
                                        <span class="stream-log-level">{{ l.level }}</span>
                                        <span>{{ l.message }}</span>
                                    </div>
                                </div>
                            </div>
                        </div>
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

                    <!-- Self-heal diagnosis panel.
                         Only shown when the execution failed. The "Diagnose
                         this failure" button kicks off an LLM analysis; the
                         cached result lives in execution_diagnoses and is
                         folded into the GET response so revisits don't
                         re-fire the LLM. -->
                    <q-expansion-item
                        v-if="execution?.status === 'failed'"
                        dense dense-toggle default-opened
                        label="Self-heal diagnosis" header-class="app-section-header"
                    >
                        <div class="q-pa-md">
                            <div v-if="!diagnosis && !diagnosing" class="row items-center q-gutter-md">
                                <span class="text-caption" style="color: var(--text-muted);">
                                    Ask the AI to classify the failure and recommend a fix.
                                    Diagnoses are cached; no automatic action is taken.
                                </span>
                                <q-space />
                                <q-btn
                                    unelevated no-caps
                                    color="primary"
                                    icon="auto_awesome"
                                    label="Diagnose this failure"
                                    @click="onDiagnose(false)"
                                />
                            </div>

                            <div v-if="diagnosing" class="row items-center q-gutter-sm">
                                <q-spinner-dots color="primary" />
                                <span class="text-caption">Analysing failure…</span>
                            </div>

                            <div v-if="diagnosisError" class="text-negative q-mb-sm">
                                {{ diagnosisError }}
                            </div>

                            <template v-if="diagnosis && diagnosis.status === 'completed'">
                                <div class="row items-center q-mb-sm q-gutter-sm">
                                    <q-chip
                                        :color="categoryColor(diagnosis.category)"
                                        text-color="white"
                                        :label="diagnosis.category"
                                        dense
                                    />
                                    <q-chip
                                        outline color="primary" dense
                                        :label="`confidence ${Math.round((diagnosis.confidence || 0) * 100)}%`"
                                    />
                                    <q-space />
                                    <span class="text-caption" style="color: var(--text-muted);">
                                        {{ diagnosis.model }} · {{ (diagnosis.input_tokens || 0) + (diagnosis.output_tokens || 0) }} tokens
                                    </span>
                                    <q-btn
                                        flat dense no-caps
                                        icon="refresh"
                                        label="Re-diagnose"
                                        @click="onDiagnose(true)"
                                    />
                                </div>

                                <div class="diagnosis-rootcause q-mb-md">
                                    {{ diagnosis.root_cause }}
                                </div>

                                <div
                                    v-if="diagnosis.recommended_actions?.length"
                                    class="text-caption q-mb-sm"
                                    style="color: var(--text-muted);"
                                >
                                    Recommended actions (manual — nothing is auto-applied):
                                </div>
                                <q-list dense bordered separator>
                                    <q-item
                                        v-for="(a, i) in diagnosis.recommended_actions"
                                        :key="i"
                                    >
                                        <q-item-section avatar>
                                            <q-icon :name="actionIcon(a.action)" />
                                        </q-item-section>
                                        <q-item-section>
                                            <q-item-label class="row items-center">
                                                <code class="recovery-name">{{ a.action }}</code>
                                                <span class="text-caption q-ml-sm" style="color: var(--text-muted);">
                                                    {{ Math.round((a.confidence || 0) * 100) }}% confident
                                                </span>
                                            </q-item-label>
                                            <q-item-label caption>{{ a.rationale }}</q-item-label>
                                            <q-item-label
                                                v-if="a.params && Object.keys(a.params).length"
                                                caption
                                            >
                                                <pre class="diagnosis-params">{{ JSON.stringify(a.params, null, 2) }}</pre>
                                            </q-item-label>
                                        </q-item-section>
                                    </q-item>
                                </q-list>
                            </template>

                            <div v-if="diagnosis?.status === 'failed'" class="text-negative">
                                Diagnosis failed: {{ diagnosis.error }}
                                <q-btn
                                    flat dense no-caps icon="refresh" label="Retry"
                                    @click="onDiagnose(true)" class="q-ml-sm"
                                />
                            </div>
                        </div>
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
import { Graphs, Executions, openLiveExecution } from "../api/client";
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

// Self-heal diagnosis (PR A). The /executions/:id GET response
// already folds in `diagnosis` when one exists; on first refresh we
// copy it into this ref so the panel renders without a separate
// fetch. `onDiagnose(force)` POSTs to /diagnose and refreshes.
const diagnosis      = ref(null);
const diagnosing     = ref(false);
const diagnosisError = ref("");

// One per waiting `user` node — keys are node names, values are the
// in-progress JSON text the operator is typing in the textarea.
const respondDrafts = reactive({});
const respondErrs   = reactive({});

// Live-output buffers populated from WS `node:stream` events. Keyed by
// node name; each entry is { text: string, logs: Array<{level,message}> }.
// In-memory only — wiped when the route changes / page reloads.
const streamBuffers = reactive({});
// Mirrors live `node:status` events so we can render a blinking cursor
// next to nodes that are still emitting.
const liveStatuses  = reactive({});
const hasStreamOutput = computed(() => Object.keys(streamBuffers).length > 0);

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
//
// Three sources contribute:
//   1. ctxNodes        — execution.context.nodes (only present after the run
//                        completes; the worker writes it once at the end).
//   2. node_states     — durable per-node rows from `persistNodeState`,
//                        updated incrementally during the run and re-fetched
//                        by the 2.5s poll loop. Carries `node_name` + `status`.
//   3. liveStatuses    — real-time `node:status` WS events. Lets us flip
//                        upstream nodes to "success" the moment they
//                        finish, even while a slow downstream node
//                        (e.g. `delay`) is still running — without this,
//                        ctxNodes is empty until the entire run completes
//                        and the graph view would render every node as
//                        "pending" for the duration of the delay.
//
// Naïve "freshest wins" merge order isn't right because WS events can
// drop or arrive out of order. If a SUCCESS event for the last node
// is lost, liveStatuses stays on "running" forever; if it overrode
// node_states / ctxNodes the user would see the node stuck on
// "running" after the run actually ended.
//
// Use STATUS PRIORITY instead: terminal states (success/failed/skipped)
// always beat transient ones (running/pending). Whichever source has
// the most advanced status wins, regardless of which sources contributed.
const STATUS_PRIORITY = {
    success: 100,
    failed:  100,
    skipped: 100,
    waiting: 80,
    running: 50,
    queued:  30,
    pending: 10,
};
function statusRank(s) { return STATUS_PRIORITY[s] ?? 0; }

const nodeStatus = computed(() => {
    const out = {};
    function consider(name, s) {
        if (!name || !s) return;
        if (!out[name] || statusRank(s) > statusRank(out[name])) {
            out[name] = s;
        }
    }
    for (const [name, n] of Object.entries(ctxNodes.value)) {
        consider(name, n?.status);
    }
    for (const row of execution.value?.node_states || []) {
        consider(row?.node_name, row?.status);
    }
    for (const [name, s] of Object.entries(liveStatuses)) {
        consider(name, s);
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
        // The GET response folds in a cached self-heal diagnosis if
        // one exists. Hydrate the panel's state so the section
        // renders the prior analysis on revisit.
        diagnosis.value = exec.diagnosis || null;
        diagnosisError.value = "";
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

// ── Live WebSocket subscription ────────────────────────────────────────────
//
// The worker broadcasts `node:status` and `node:stream` for the run
// being processed; we subscribe per-execution and route stream chunks
// into per-node buffers. The polling loop also still runs — WS gives
// us instant token updates while the polled GET refreshes the
// authoritative status / node_states snapshot.
let liveWs = null;
function openLive() {
    closeLive();
    if (!route.params.id) return;
    liveWs = openLiveExecution(route.params.id, (msg) => {
        if (!msg || !msg.node) return;
        if (msg.type === "node:status") {
            if (msg.status) liveStatuses[msg.node] = msg.status;
            return;
        }
        if (msg.type === "node:stream") {
            const buf = streamBuffers[msg.node] ||= { text: "", logs: [] };
            if (msg.kind === "text" && msg.chunk) {
                buf.text += msg.chunk;
            } else if (msg.kind === "log") {
                buf.logs.push({
                    level:   msg.level || "info",
                    message: msg.message || "",
                });
            } else if (msg.kind === "data" && msg.payload != null) {
                // Record as a log line so the user still sees it; if you
                // want a structured renderer, branch here.
                buf.logs.push({ level: "info", message: JSON.stringify(msg.payload) });
            }
        }
    });
}
function closeLive() {
    try { liveWs?.close?.(); } catch { /* ignore */ }
    liveWs = null;
}

// ── Lifecycle ──────────────────────────────────────────────────────────────
onMounted(async () => {
    await loadExecution();
    openLive();
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

onBeforeUnmount(() => { stopPolling(); closeLive(); });

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

// ──────────────────────────────────────────────────────────────────
// Self-heal — diagnose-on-demand (PR A)
// ──────────────────────────────────────────────────────────────────

async function onDiagnose(force = false) {
    if (!execution.value?.id) return;
    diagnosing.value     = true;
    diagnosisError.value = "";
    try {
        const { diagnosis: d } = await Executions.diagnose(execution.value.id, { force });
        diagnosis.value = d;
    } catch (e) {
        diagnosisError.value = errMsg(e);
    } finally {
        diagnosing.value = false;
    }
}

// Category → chip colour. Same palette the dashboard uses for
// failure types so the visual language is consistent.
function categoryColor(cat) {
    switch (cat) {
        case "transient": return "warning";
        case "config":    return "info";
        case "code":      return "negative";
        case "external":  return "purple";
        default:          return "grey-7";
    }
}

// Action → Material icon. Mirrors the manual Recovery panel icons
// so the same operator gesture maps to the same visual.
function actionIcon(action) {
    switch (action) {
        case "retry":              return "play_arrow";
        case "retry-with-timeout": return "schedule";
        case "retry-with-inputs":  return "edit";
        case "skip":               return "redo";
        case "escalate":           return "report";
        default:                   return "auto_awesome";
    }
}
</script>

<style scoped>
/* Self-heal diagnosis panel */
.diagnosis-rootcause {
    background: rgba(47, 109, 243, 0.06);
    border-left: 3px solid var(--q-primary, #2f6df3);
    padding: 10px 12px;
    border-radius: 4px;
    font-size: 13px;
    line-height: 1.45;
    color: var(--text);
}
.diagnosis-params {
    font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: 11px;
    margin: 4px 0 0;
    white-space: pre-wrap;
    background: rgba(0, 0, 0, 0.04);
    padding: 4px 6px;
    border-radius: 4px;
}

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

/* Live-output cards — one per node that has streamed anything */
.stream-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-left: 3px solid var(--success);
    border-radius: 6px;
    padding: 12px 14px;
}
.stream-text {
    margin: 0;
    padding: 8px 10px;
    background: rgba(0,0,0,0.06);
    border-radius: 4px;
    font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: 12.5px;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 360px;
    overflow-y: auto;
}
.cursor-blink {
    display: inline-block;
    color: var(--primary);
    animation: cursor-blink 1s steps(2, start) infinite;
}
@keyframes cursor-blink {
    to { visibility: hidden; }
}
.stream-logs {
    margin-top: 8px;
    border-top: 1px dashed var(--border);
    padding-top: 6px;
    font-size: 11.5px;
    font-family: ui-monospace, Menlo, Consolas, monospace;
    max-height: 160px;
    overflow-y: auto;
}
.stream-log {
    display: flex;
    gap: 8px;
    align-items: baseline;
    padding: 1px 0;
}
.stream-log-level {
    text-transform: uppercase;
    font-size: 10px;
    padding: 0 5px;
    border-radius: 3px;
    background: rgba(0,0,0,0.06);
    color: var(--text-muted);
}
.stream-log-warn  .stream-log-level { background: var(--warning-soft); color: var(--warning); }
.stream-log-error .stream-log-level { background: var(--danger-soft);  color: var(--danger); }

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
