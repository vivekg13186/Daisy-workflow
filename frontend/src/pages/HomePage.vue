<!--
  Home page — VS Code style activity bar on the left, content on the right.
  The previous single-page-with-stacked-tables version is preserved as
  HomePage.legacy.vue.

  Sections (driven by role):
    workflows         admin, editor          (viewer: hidden)
    triggers          admin, editor          (viewer: hidden)
    agents            admin, editor          (viewer: hidden)
    configs           admin (edit) +
                      editor (view-only)     (viewer: hidden)
    instances         admin, editor, viewer
    running           admin, editor          (viewer: hidden)

  Row-click conventions:
    • Workflow → opens FlowDesigner in a NEW TAB. The editor is heavy
      enough that this matches user habit of "keep multiple workflows
      open at once".
    • Everything else → same-tab navigation to its respective editor /
      detail page.

  Persistence: the chosen section lives in the URL as ?view=<key> so
  reloads and shared links land on the same panel.
-->

<template>
  <q-layout view="hHh lpR fFf">
    <q-header class="app-header">
      <q-toolbar class="app-toolbar">
        <q-img src="/dag_logo_trans.png" style="width: 28px; height: 28px;" class="q-mr-sm" />
        <q-toolbar-title>DAISY Workflow Engine</q-toolbar-title>
      </q-toolbar>
    </q-header>

    <!-- Activity bar — fixed-width vertical rail of icons -->
    <q-drawer
      side="left"
      :model-value="true"
      :width="64"
      bordered
      persistent
      class="activity-bar"
    >
      <div class="rail">
        <q-btn
          v-for="item in visibleSections"
          :key="item.key"
          flat dense round
          :icon="item.icon"
          class="rail-btn"
          :class="{ active: activeKey === item.key }"
          @click="setActive(item.key)"
        >
          <q-tooltip anchor="center right" self="center left" :offset="[10, 0]">
            {{ item.tooltip }}
          </q-tooltip>
        </q-btn>
      </div>
    </q-drawer>

    <q-page-container>
      <q-page class="app-page home-content">
        <div class="content-header q-mb-md">
          <div class="text-h6">{{ activeLabel }}</div>
          <div class="text-caption text-grey-7">{{ activeSubtitle }}</div>
        </div>

        <!-- Workflows ──────────────────────────────────────────────── -->
        <AppTable
          v-if="activeKey === 'workflows'"
          :rows="wf_rows"
          :columns="wf_columns"
          title="Workflows"
          @add="onAddWorkflow"
          @edit="onEditWorkflow"
          @delete="onDeleteWorkflow"
          @delete-selected="onDeleteSelectedWorkflows"
        />

        <!-- Triggers ───────────────────────────────────────────────── -->
        <AppTable
          v-else-if="activeKey === 'triggers'"
          :rows="trigger_rows"
          :columns="trigger_columns"
          title="Triggers"
          @add="onAddTrigger"
          @edit="onEditTrigger"
          @delete="onDeleteTrigger"
          @delete-selected="onDeleteSelectedTriggers"
        />

        <!-- Agents ─────────────────────────────────────────────────── -->
        <AppTable
          v-else-if="activeKey === 'agents'"
          :rows="agent_rows"
          :columns="agent_columns"
          title="Agents"
          @add="onAddAgent"
          @edit="onEditAgent"
          @delete="onDeleteAgent"
          @delete-selected="onDeleteSelectedAgents"
        />

        <!-- Configurations (admin: full CRUD; editor: read-only) ───── -->
        <AppTable
          v-else-if="activeKey === 'configs'"
          :rows="config_rows"
          :columns="config_columns"
          :title="isAdmin ? 'Configurations' : 'Configurations (read-only)'"
          :read-only="!isAdmin"
          :clickable="isAdmin"
          @add="onAddConfig"
          @edit="onEditConfig"
          @delete="onDeleteConfig"
          @delete-selected="onDeleteSelectedConfigs"
        />

        <!-- Instances — every role sees executions list ────────────── -->
        <AppTable
          v-else-if="activeKey === 'instances'"
          :rows="exec_rows"
          :columns="exec_columns"
          title="Instances"
          :read-only="true"
          @edit="onOpenInstance"
        />

        <!-- Running triggers — enabled triggers with no last_error ─── -->
        <AppTable
          v-else-if="activeKey === 'running'"
          :rows="running_rows"
          :columns="trigger_columns"
          title="Running triggers"
          :read-only="true"
          @edit="onEditTrigger"
        />
      </q-page>
    </q-page-container>
  </q-layout>
</template>

<script setup>
import { ref, computed, onMounted, watch } from "vue";
import { useRouter, useRoute } from "vue-router";
import { useQuasar } from "quasar";
import { Graphs, Triggers, Configs, Agents, Executions } from "../api/client";
import { auth } from "../stores/auth.js";
import AppTable from "../components/AppTable.vue";

const router = useRouter();
const route  = useRoute();
const $q     = useQuasar();

// ──────────────────────────────────────────────────────────────────────
// Sidebar items + role gating
// ──────────────────────────────────────────────────────────────────────
const isAdmin  = computed(() => auth.user?.role === "admin");
const isEditor = computed(() => auth.user?.role === "editor");
const isViewer = computed(() => auth.user?.role === "viewer");

// `roles` lists every role allowed to SEE this section. Configuration
// is visible to admin + editor but the editor flavour is read-only —
// the `readOnlyFor` field is consumed at render time, not here.
const sections = [
  { key: "workflows", icon: "schema",           label: "Workflows",
    tooltip: "Workflows",         subtitle: "Workflow definitions in this workspace.",
    roles: ["admin", "editor"] },
  { key: "triggers",  icon: "bolt",             label: "Triggers",
    tooltip: "Triggers",          subtitle: "Schedule / webhook / MQTT / email sources that fire workflows.",
    roles: ["admin", "editor"] },
  { key: "agents",    icon: "smart_toy",        label: "Agents",
    tooltip: "Agents",            subtitle: "LLM personas referenced by the agent plugin.",
    roles: ["admin", "editor"] },
  { key: "configs",   icon: "settings_input_component", label: "Configurations",
    tooltip: "Configurations",    subtitle: "Reusable credentials & connection settings.",
    roles: ["admin", "editor"] },
  { key: "instances", icon: "monitor",          label: "Instances",
    tooltip: "Instances",         subtitle: "Live and historical workflow executions.",
    roles: ["admin", "editor", "viewer"] },
  { key: "running",   icon: "play_circle",      label: "Running triggers",
    tooltip: "Running triggers",  subtitle: "Triggers currently subscribed and listening for events.",
    roles: ["admin", "editor"] },
];

const visibleSections = computed(() => {
  if (!auth.user) return [];
  return sections.filter(s => s.roles.includes(auth.user.role));
});

// Default section depends on role: viewers should land on Instances
// (only thing they can access), everyone else lands on Workflows.
function defaultKey() {
  if (isViewer.value) return "instances";
  return "workflows";
}

const activeKey = ref(route.query.view || defaultKey());

const active = computed(() =>
  visibleSections.value.find(s => s.key === activeKey.value) ||
  visibleSections.value[0] ||
  null,
);
const activeLabel    = computed(() => active.value?.label    || "");
const activeSubtitle = computed(() => active.value?.subtitle || "");

function setActive(key) {
  if (key === activeKey.value) return;
  activeKey.value = key;
  // Sync URL so reload + shared links land here.
  router.replace({ query: { ...route.query, view: key } });
}

// If the URL ever lands on a section the current user can't see (e.g.
// a viewer bookmarking ?view=configs), bounce them to their default.
watch(visibleSections, (vs) => {
  if (vs.length && !vs.some(s => s.key === activeKey.value)) {
    setActive(defaultKey());
  }
}, { immediate: true });

// ──────────────────────────────────────────────────────────────────────
// Data sources
// ──────────────────────────────────────────────────────────────────────
const wf_rows      = ref([]);
const trigger_rows = ref([]);
const config_rows  = ref([]);
const agent_rows   = ref([]);
const exec_rows    = ref([]);

const running_rows = computed(() =>
  trigger_rows.value.filter(t => t.enabled && !t.last_error),
);

// ──────────────────────────────────────────────────────────────────────
// Columns (same shapes as the legacy HomePage so AppTable behaves
// identically across both pages).
// ──────────────────────────────────────────────────────────────────────
const wf_columns = [
  { name: "action", label: "", style: "width:2px" },
  { name: "name",   label: "Name", field: "name", align: "left", sortable: true },
  { name: "id",     label: "ID",   field: "id",   align: "left", style: "width: 300px" },
  {
    name: "updated", label: "Updated", field: "updated_at", align: "left", sortable: true,
    format: v => v ? new Date(v).toLocaleString() : "",
  },
  {
    name: "updated_by_email", label: "Modified by",
    field: "updated_by_email", align: "left",
    format: v => v || "—",
    style: "width: 200px",
  },
  { name: "actions", label: "", align: "right", style: "width: 80px;" },
];

const trigger_columns = [
  { name: "action", label: "", style: "width:2px" },
  {
    name: "status", label: "Status", field: row => triggerStatusLabel(row),
    align: "left", style: "width: 70px;",
  },
  { name: "name",  label: "Name",  field: "name", align: "left", sortable: true },
  { name: "type",  label: "Type",  field: "type", align: "left", sortable: true, style: "width: 70px;" },
  { name: "graph", label: "Flow",  field: row => graphName(row.graph_id), align: "left" },
  { name: "fires", label: "Fires", field: "fire_count", align: "right", style: "width: 60px;" },
  {
    name: "lastFired", label: "Last", field: "last_fired_at", align: "left",
    format: v => v ? new Date(v).toLocaleString() : "—",
  },
  {
    name: "updated_by_email", label: "Modified by",
    field: "updated_by_email", align: "left",
    format: v => v || "—",
    style: "width: 180px",
  },
  { name: "actions", label: "", align: "right", style: "width: 80px;" },
];

const config_columns = [
  { name: "action", label: "", style: "width:2px" },
  { name: "name",        label: "Name",        field: "name",        align: "left", sortable: true },
  { name: "type",        label: "Type",        field: "type",        align: "left", sortable: true, style: "width: 130px;" },
  { name: "description", label: "Description", field: "description", align: "left" },
  {
    name: "updated", label: "Updated", field: "updated_at", align: "left", sortable: true,
    format: v => v ? new Date(v).toLocaleString() : "",
  },
  {
    name: "updated_by_email", label: "Modified by",
    field: "updated_by_email", align: "left",
    format: v => v || "—",
    style: "width: 200px",
  },
  { name: "actions", label: "", align: "right", style: "width: 80px;" },
];

const agent_columns = [
  { name: "action", label: "", style: "width:2px" },
  { name: "title",       label: "Title",       field: "title",       align: "left", sortable: true },
  { name: "config_name", label: "AI provider", field: "config_name", align: "left", sortable: true, style: "width: 200px;" },
  { name: "description", label: "Description", field: "description", align: "left" },
  {
    name: "updated", label: "Updated", field: "updated_at", align: "left", sortable: true,
    format: v => v ? new Date(v).toLocaleString() : "",
  },
  {
    name: "updated_by_email", label: "Modified by",
    field: "updated_by_email", align: "left",
    format: v => v || "—",
    style: "width: 200px",
  },
  { name: "actions", label: "", align: "right", style: "width: 80px;" },
];

const exec_columns = [
  { name: "action", label: "", style: "width:2px" },
  {
    name: "status", label: "Status", field: "status",
    align: "left", style: "width: 90px;",
  },
  // Primary clickable column. Named "name" so AppTable's
  // body-cell-name slot wires up the link affordance + click handler
  // (which the parent listens for as @edit → onOpenInstance).
  { name: "name", label: "Workflow", field: "graph_name", align: "left", sortable: true },
  { name: "id",   label: "Execution", field: "id", align: "left", style: "width: 300px" },
  {
    name: "started", label: "Started", field: "started_at", align: "left", sortable: true,
    format: v => v ? new Date(v).toLocaleString() : "—",
  },
  {
    name: "duration", label: "Duration",
    field: row => (row.started_at && row.finished_at)
      ? `${Math.round((new Date(row.finished_at) - new Date(row.started_at)) / 1000)}s` : "—",
    align: "right", style: "width: 80px;",
  },
  { name: "actions", label: "", align: "right", style: "width: 80px;" },
];

function graphName(graphId) {
  const g = wf_rows.value.find(x => x.id === graphId);
  return g ? g.name : (graphId ? graphId.slice(0, 8) + "…" : "");
}
function triggerStatusLabel(row) {
  if (!row?.enabled) return "off";
  if (row?.last_error) return "error";
  return "running";
}

// ──────────────────────────────────────────────────────────────────────
// Reload — each list is only fetched if the role allows reading it.
// We always fetch in parallel and tolerate per-list failures so one
// broken endpoint doesn't black out the page.
// ──────────────────────────────────────────────────────────────────────
async function reload() {
  const canSee = (key) => visibleSections.value.some(s => s.key === key);

  const [graphs, triggers, configs, agents, execs] = await Promise.all([
    canSee("workflows") ? Graphs.list().catch(() => [])    : Promise.resolve([]),
    canSee("triggers")  ? Triggers.list().catch(() => [])  : Promise.resolve([]),
    canSee("configs")   ? Configs.list().catch(() => [])   : Promise.resolve([]),
    canSee("agents")    ? Agents.list().catch(() => [])    : Promise.resolve([]),
    canSee("instances") ? Executions.list({ limit: 100 }).catch(() => []) : Promise.resolve([]),
  ]);
  wf_rows.value      = graphs;
  trigger_rows.value = triggers;
  config_rows.value  = configs;
  agent_rows.value   = agents;
  exec_rows.value    = execs;
}
onMounted(reload);

// ──────────────────────────────────────────────────────────────────────
// Row actions
//
// Workflow rows open in a NEW TAB — they're the heaviest editor and
// users keep several open at once. Everything else stays in-page.
// ──────────────────────────────────────────────────────────────────────
function onAddWorkflow() {
  window.open("/flowDesigner/new", "_blank", "noopener");
}
function onEditWorkflow(row) {
  window.open(`/flowDesigner/${row.id}`, "_blank", "noopener");
}
async function onDeleteWorkflow(row) {
  if (!await confirm(`Delete workflow "${row.name}"?`)) return;
  try { await Graphs.remove(row.id); notify(`Deleted "${row.name}"`, "positive"); await reload(); }
  catch (e) { notify(`Delete failed: ${errMsg(e)}`, "negative"); }
}
async function onDeleteSelectedWorkflows(rows) {
  if (!rows?.length) return;
  if (!await confirm(`Delete ${rows.length} workflow(s)?`)) return;
  let failed = 0;
  for (const r of rows) { try { await Graphs.remove(r.id); } catch { failed++; } }
  notify(failed ? `Deleted ${rows.length - failed} of ${rows.length} (${failed} failed)`
                : `Deleted ${rows.length} workflow(s)`, failed ? "warning" : "positive");
  await reload();
}

function onAddTrigger()      { router.push({ path: "/triggerDesigner/new" }); }
function onEditTrigger(row)  { router.push({ path: `/triggerDesigner/${row.id}` }); }
async function onDeleteTrigger(row) {
  if (!await confirm(`Delete trigger "${row.name}"? It will be unsubscribed and removed.`)) return;
  try { await Triggers.remove(row.id); notify(`Deleted "${row.name}"`, "positive"); await reload(); }
  catch (e) { notify(`Delete failed: ${errMsg(e)}`, "negative"); }
}
async function onDeleteSelectedTriggers(rows) {
  if (!rows?.length) return;
  if (!await confirm(`Delete ${rows.length} trigger(s)?`)) return;
  let failed = 0;
  for (const r of rows) { try { await Triggers.remove(r.id); } catch { failed++; } }
  notify(failed ? `Deleted ${rows.length - failed} of ${rows.length} (${failed} failed)`
                : `Deleted ${rows.length} trigger(s)`, failed ? "warning" : "positive");
  await reload();
}

function onAddAgent()        { router.push({ path: "/agentDesigner/new" }); }
function onEditAgent(row)    { router.push({ path: `/agentDesigner/${row.id}` }); }
async function onDeleteAgent(row) {
  if (!await confirm(`Delete agent "${row.title}"? Any plugin nodes referencing it will start failing.`)) return;
  try { await Agents.remove(row.id); notify(`Deleted "${row.title}"`, "positive"); await reload(); }
  catch (e) { notify(`Delete failed: ${errMsg(e)}`, "negative"); }
}
async function onDeleteSelectedAgents(rows) {
  if (!rows?.length) return;
  if (!await confirm(`Delete ${rows.length} agent(s)?`)) return;
  let failed = 0;
  for (const r of rows) { try { await Agents.remove(r.id); } catch { failed++; } }
  notify(failed ? `Deleted ${rows.length - failed} of ${rows.length} (${failed} failed)`
                : `Deleted ${rows.length} agent(s)`, failed ? "warning" : "positive");
  await reload();
}

function onAddConfig()       { router.push({ path: "/configDesigner/new" }); }
function onEditConfig(row)   { router.push({ path: `/configDesigner/${row.id}` }); }
async function onDeleteConfig(row) {
  if (!await confirm(`Delete configuration "${row.name}"? Anything referencing ${'${'}config.${row.name}.*${'}'} will stop resolving.`)) return;
  try { await Configs.remove(row.id); notify(`Deleted "${row.name}"`, "positive"); await reload(); }
  catch (e) { notify(`Delete failed: ${errMsg(e)}`, "negative"); }
}
async function onDeleteSelectedConfigs(rows) {
  if (!rows?.length) return;
  if (!await confirm(`Delete ${rows.length} configuration(s)?`)) return;
  let failed = 0;
  for (const r of rows) { try { await Configs.remove(r.id); } catch { failed++; } }
  notify(failed ? `Deleted ${rows.length - failed} of ${rows.length} (${failed} failed)`
                : `Deleted ${rows.length} configuration(s)`, failed ? "warning" : "positive");
  await reload();
}

function onOpenInstance(row) {
  router.push({ name: "instanceViewer", params: { id: row.id } });
}

// ──────────────────────────────────────────────────────────────────────
// helpers
// ──────────────────────────────────────────────────────────────────────
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

<style scoped>
/*
  Light-themed activity bar. Surface tones match the rest of the app
  (light Quasar theme + brand primary #2f6df3 from main.js).
*/
.activity-bar {
  background: #ffffff;
  border-right: 1px solid #e2e8f0;
}
.rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding-top: 8px;
  gap: 4px;
}
.rail-btn {
  width: 48px;
  height: 48px;
  border-radius: 8px;
  color: #64748b;            /* slate-500 — readable but recedes */
}
.rail-btn:hover {
  color: #0f172a;            /* slate-900 on hover */
  background: rgba(15, 23, 42, 0.04);
}
.rail-btn.active {
  /* Tinted in primary so the active state pops against the white
     rail without going as heavy as a filled chip. */
  color: #2f6df3;
  background: rgba(47, 109, 243, 0.10);
  position: relative;
}
.rail-btn.active::before {
  content: "";
  position: absolute;
  left: -8px;
  top: 8px;
  bottom: 8px;
  width: 3px;
  background: #2f6df3;
  border-radius: 0 2px 2px 0;
}
.home-content {
  padding: 18px 22px;
}
.content-header {
  margin-bottom: 12px;
}
</style>
