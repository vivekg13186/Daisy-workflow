<template>
    <q-layout view="hHh lpR fFf">

        <q-header class="bg-grey-12">
            <q-toolbar>
                <q-toolbar-title>
                    <div class="q-pa-xs   text-black">
                        <q-img src="/dag_logo_trans.png" style="width: 55px;"></q-img>
                        <b>DAISY DAG</b>
                    </div>
                </q-toolbar-title>
                <q-space />
                <q-btn
                    flat dense no-caps
                    icon="monitor_heart"
                    label="Inspector"
                    class="text-black"
                    @click="onOpenInspector"
                >
                    <q-tooltip>Live executions and trigger controls</q-tooltip>
                </q-btn>
            </q-toolbar>
        </q-header>

        <q-page-container>
            <q-page>
                <div class="q-gutter-md q-pa-md">
                    <AppTable
                        :rows="wf_rows"
                        :columns="wf_columns"
                        title="Workflows"
                        @add="onAddWorkflow"
                        @edit="onEditWorkflow"
                        @delete="onDeleteWorkflow"
                        @delete-selected="onDeleteSelectedWorkflows"
                    />
                    <AppTable
                        :rows="trigger_rows"
                        :columns="trigger_columns"
                        title="Triggers"
                        @add="onAddTrigger"
                        @edit="onEditTrigger"
                        @delete="onDeleteTrigger"
                        @delete-selected="onDeleteSelectedTriggers"
                    />
                    <AppTable
                        :rows="config_rows"
                        :columns="config_columns"
                        title="Configurations"
                        @add="onAddConfig"
                        @edit="onEditConfig"
                        @delete="onDeleteConfig"
                        @delete-selected="onDeleteSelectedConfigs"
                    />
                </div>
            </q-page>

        </q-page-container>

    </q-layout>
</template>
<script setup>
import { ref, onMounted } from "vue";
import { useRouter } from "vue-router";
import { useQuasar } from "quasar";
import { Graphs, Triggers, Configs } from "../api/client";
import AppTable from "../components/AppTable.vue";

const router = useRouter();
const $q = useQuasar();

const wf_rows = ref([]);
const trigger_rows = ref([]);
const config_rows = ref([]);

const wf_columns = [
    { name: "action", label: "", style: "width:2px" },
    { name: "name", label: "Name", field: "name", align: "left", sortable: true },
    { name: "version", label: "Version", field: "version", align: "left", sortable: true, style: "width: 10px;" },
    {
        name: "updated", label: "Updated", field: "updated_at", align: "left", sortable: true,
        format: v => v ? new Date(v).toLocaleString() : "",
    },
    { name: "actions", label: "", align: "right", style: "width: 80px;" },
];

const trigger_columns = [
    { name: "action", label: "", style: "width:2px" },
    {
        name: "status", label: "Status", field: row => triggerStatusLabel(row),
        align: "left", style: "width: 70px;",
    },
    { name: "name", label: "Name", field: "name", align: "left", sortable: true },
    { name: "type", label: "Type", field: "type", align: "left", sortable: true, style: "width: 70px;" },
    { name: "graph", label: "Flow", field: row => graphName(row.graph_id), align: "left" },
    { name: "fires", label: "Fires", field: "fire_count", align: "right", style: "width: 60px;" },
    {
        name: "lastFired", label: "Last", field: "last_fired_at", align: "left",
        format: v => v ? new Date(v).toLocaleString() : "—",
    },
    { name: "actions", label: "", align: "right", style: "width: 80px;" },
];

const config_columns = [
    { name: "action", label: "", style: "width:2px" },
    { name: "name",   label: "Name",   field: "name", align: "left", sortable: true },
    { name: "type",   label: "Type",   field: "type", align: "left", sortable: true, style: "width: 130px;" },
    { name: "description", label: "Description", field: "description", align: "left" },
    {
        name: "updated", label: "Updated", field: "updated_at", align: "left", sortable: true,
        format: v => v ? new Date(v).toLocaleString() : "",
    },
    { name: "actions", label: "", align: "right", style: "width: 80px;" },
];

function graphName(graphId) {
    const g = wf_rows.value.find(x => x.id === graphId);
    return g ? `${g.name} (v${g.version})` : (graphId ? graphId.slice(0, 8) + "…" : "");
}
function triggerStatusLabel(row) {
    if (!row?.enabled) return "off";
    if (row?.last_error) return "error";
    return "running";
}

async function reload() {
    const [graphs, triggers, configs] = await Promise.all([
        Graphs.list().catch(() => []),
        Triggers.list().catch(() => []),
        Configs.list().catch(() => []),
    ]);
    wf_rows.value      = graphs;
    trigger_rows.value = triggers;
    config_rows.value  = configs;
}
onMounted(reload);

// ----- header → FlowInspector -----
function onOpenInspector() {
    router.push({ path: "/flowInspector" });
}

// ----- workflow actions → FlowDesigner -----
function onAddWorkflow() {
    router.push({ path: "/flowDesigner/new" });
}
function onEditWorkflow(row) {
    router.push({ path: `/flowDesigner/${row.id}` });
}
async function onDeleteWorkflow(row) {
    if (!await confirm(`Delete workflow "${row.name}" (v${row.version})?`)) return;
    try {
        await Graphs.remove(row.id);
        notify(`Deleted "${row.name}"`, "positive");
        await reload();
    } catch (e) {
        notify(`Delete failed: ${errMsg(e)}`, "negative");
    }
}
async function onDeleteSelectedWorkflows(rows) {
    if (!rows?.length) return;
    if (!await confirm(`Delete ${rows.length} workflow(s)?`)) return;
    let failed = 0;
    for (const r of rows) {
        try { await Graphs.remove(r.id); } catch { failed++; }
    }
    notify(failed
        ? `Deleted ${rows.length - failed} of ${rows.length} (${failed} failed)`
        : `Deleted ${rows.length} workflow(s)`,
        failed ? "warning" : "positive");
    await reload();
}

// ----- trigger actions → TriggerDesigner -----
function onAddTrigger() {
    router.push({ path: "/triggerDesigner/new" });
}
function onEditTrigger(row) {
    router.push({ path: `/triggerDesigner/${row.id}` });
}
async function onDeleteTrigger(row) {
    if (!await confirm(`Delete trigger "${row.name}"? It will be unsubscribed and removed.`)) return;
    try {
        await Triggers.remove(row.id);
        notify(`Deleted "${row.name}"`, "positive");
        await reload();
    } catch (e) {
        notify(`Delete failed: ${errMsg(e)}`, "negative");
    }
}
async function onDeleteSelectedTriggers(rows) {
    if (!rows?.length) return;
    if (!await confirm(`Delete ${rows.length} trigger(s)?`)) return;
    let failed = 0;
    for (const r of rows) {
        try { await Triggers.remove(r.id); } catch { failed++; }
    }
    notify(failed
        ? `Deleted ${rows.length - failed} of ${rows.length} (${failed} failed)`
        : `Deleted ${rows.length} trigger(s)`,
        failed ? "warning" : "positive");
    await reload();
}

// ----- config actions → ConfigDesigner -----
function onAddConfig() {
    router.push({ path: "/configDesigner/new" });
}
function onEditConfig(row) {
    router.push({ path: `/configDesigner/${row.id}` });
}
async function onDeleteConfig(row) {
    if (!await confirm(`Delete configuration "${row.name}"? Anything referencing ${'${'}config.${row.name}.*${'}'} will stop resolving.`)) return;
    try {
        await Configs.remove(row.id);
        notify(`Deleted "${row.name}"`, "positive");
        await reload();
    } catch (e) {
        notify(`Delete failed: ${errMsg(e)}`, "negative");
    }
}
async function onDeleteSelectedConfigs(rows) {
    if (!rows?.length) return;
    if (!await confirm(`Delete ${rows.length} configuration(s)?`)) return;
    let failed = 0;
    for (const r of rows) {
        try { await Configs.remove(r.id); } catch { failed++; }
    }
    notify(failed
        ? `Deleted ${rows.length - failed} of ${rows.length} (${failed} failed)`
        : `Deleted ${rows.length} configuration(s)`,
        failed ? "warning" : "positive");
    await reload();
}

// ----- helpers -----
function errMsg(e) { return e?.response?.data?.message || e?.message || "unknown error"; }
function confirm(message) {
    return new Promise((resolve) => {
        $q.dialog({
            title: "Confirm",
            message,
            persistent: true,
            ok:     { label: "Delete", color: "negative", unelevated: true, "no-caps": true },
            cancel: { label: "Cancel", flat: true,  "no-caps": true },
        })
            .onOk(() => resolve(true))
            .onDismiss(() => resolve(false));
    });
}
function notify(message, type = "positive") {
    $q.notify({ type, message, timeout: 1800, position: "bottom" });
}
</script>
