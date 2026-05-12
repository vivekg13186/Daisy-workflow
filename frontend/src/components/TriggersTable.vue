<!--
  TriggersTable — focused copy of AppTable tailored for the Triggers
  view on HomePage. Differences from AppTable:

    • Inline per-row action buttons (Run now, Start/Stop, Edit, Delete)
      instead of a more_vert menu — the four operations are the
      primary affordance for a trigger row, not a hidden submenu.

    • Start ↔ Stop is a single toggle driven by the row's `enabled`
      flag, so the user doesn't have to think about which state the
      subscription is in to flip it. `playing-busy` per-row spinner
      prevents double-clicks while the API call is in flight.

    • Edit + Delete are gated on role. Only admin + editor see them;
      viewers see only Run/Start/Stop (and the underlying API rejects
      mutations anyway, so this is purely UX).

    • Drops the multi-select / bulk-delete affordances — triggers
      are usually managed one-at-a-time and the row buttons cover it.

  Replaces the dedicated "Running triggers" view: the same buttons
  flip subscription state in place, so there's no longer a need to
  switch tabs to see/control running triggers.
-->

<template>
  <q-table
    v-model:selected="selected"
    :rows="filteredRows"
    :columns="columns"
    :title="title"
    row-key="id"
    flat dense bordered
    selection="multiple"
    :rows-per-page-options="[10, 25, 50, 100]"
  >
    <template v-slot:top-right>
      <q-input v-model="filter" borderless dense debounce="300" placeholder="Search" class="q-mr-sm">
        <template v-slot:append>
          <q-icon name="search" size="sm" />
        </template>
      </q-input>

      <q-btn
        icon="refresh" flat dense size="sm"
        :loading="refreshing"
        @click="onRefresh"
      >
        <q-tooltip>Refresh</q-tooltip>
      </q-btn>

      <q-btn
        icon="download" flat dense size="sm"
        @click="onExport"
      >
        <!-- Tooltip flips based on selection so the action is unambiguous:
             user can see at a glance whether they're about to dump the
             whole table or just the boxes they've ticked. -->
        <q-tooltip>
          {{ selected.length
              ? `Export ${selected.length} selected to JSON`
              : "Export all triggers to JSON" }}
        </q-tooltip>
        <q-badge
          v-if="selected.length"
          color="primary" floating
          :label="selected.length"
        />
      </q-btn>
      <q-btn
        v-if="canEdit"
        icon="upload" flat dense size="sm"
        @click="onImport"
      >
        <q-tooltip>Import triggers from JSON</q-tooltip>
      </q-btn>

      <q-btn v-if="canEdit" icon="add" flat dense size="sm" @click="onAdd">
        <q-tooltip>New trigger</q-tooltip>
      </q-btn>
    </template>

    <!-- Name column — primary clickable label that opens the editor.
         Only clickable when the user has edit rights; otherwise plain
         text. -->
    <template v-slot:body-cell-name="props">
      <q-td :props="props">
        <span
          v-if="canEdit"
          class="text-primary cursor-pointer"
          @click="onEdit(props.row)"
        >
          {{ props.value }}
        </span>
        <span v-else>{{ props.value }}</span>
      </q-td>
    </template>

    <!-- Status pill — small coloured tag that matches the trigger's
         live state (running / failed / disabled) so the user doesn't
         have to read the enabled column + last_error to know what's
         happening. The render mirrors FlowInspector's pill. -->
    <template v-slot:body-cell-status="props">
      <q-td :props="props">
        <span
          class="trigger-pill"
          :class="props.row.enabled
            ? (props.row.last_error ? 'pill-failed' : 'pill-running')
            : 'pill-stopped'"
        >
          {{ triggerStatusLabel(props.row) }}
        </span>
      </q-td>
    </template>

    <!-- Inline action buttons — replaces the more_vert submenu.
         Run-now works regardless of enabled state. Start/Stop is
         a single button whose icon + colour flips with enabled.
         Edit + Delete are admin/editor only. -->
    <template v-slot:body-cell-actions="props">
      <q-td :props="props" auto-width class="row-actions">
        <q-btn
          icon="play_arrow" flat round dense size="sm" color="positive"
          :loading="busyRow[props.row.id]"
          @click.stop="onRun(props.row)"
        >
          <q-tooltip>Run now (fire once)</q-tooltip>
        </q-btn>

        <q-btn
          v-if="!props.row.enabled"
          icon="power_settings_new" flat round dense size="sm" color="grey-7"
          :loading="busyRow[props.row.id]"
          @click.stop="onStart(props.row)"
        >
          <q-tooltip>Start subscription</q-tooltip>
        </q-btn>
        <q-btn
          v-else
          icon="stop" flat round dense size="sm" color="negative"
          :loading="busyRow[props.row.id]"
          @click.stop="onStop(props.row)"
        >
          <q-tooltip>Stop (disable subscription)</q-tooltip>
        </q-btn>

        <q-btn
          v-if="canEdit"
          icon="edit" flat round dense size="sm"
          @click.stop="onEdit(props.row)"
        >
          <q-tooltip>Edit</q-tooltip>
        </q-btn>
        <q-btn
          v-if="canEdit"
          icon="delete" flat round dense size="sm" color="negative"
          @click.stop="onDelete(props.row)"
        >
          <q-tooltip>Delete</q-tooltip>
        </q-btn>
      </q-td>
    </template>
  </q-table>
</template>

<script setup>
import { computed, ref, watch } from "vue";

const props = defineProps({
  rows:    { type: Array,  default: () => [] },
  columns: { type: Array,  default: () => [] },
  title:   { type: String, default: "Triggers" },
  // User's role, passed by the parent. Edit + Delete + the Add
  // button + the clickable name link are hidden when the user
  // can't mutate. The backend enforces the same rule on every
  // mutating endpoint, so this is purely a UX gate.
  role:    { type: String, default: "viewer" },
  // Per-row busy map { [id]: boolean } so the parent's async
  // handlers can flag a row as in-flight. Drives the loading
  // spinner on the action buttons.
  busyRow: { type: Object, default: () => ({}) },
});

const emit = defineEmits([
  "edit",
  "add",
  "delete",
  "refresh",
  "run",
  "start",
  "stop",
  // Bulk Import / Export of triggers. Export carries the current
  // selection (possibly empty); the parent treats an empty array
  // as "export everything." Import is a fire-and-forget signal —
  // parent opens its own picker.
  "import",
  "export",
  // Mirrors q-table's selection state up so the parent can show
  // selection-aware UI (e.g. a "selected N" banner) if it wants.
  "selection-change",
]);

const filter      = ref("");
const refreshing  = ref(false);
// Multi-select state — drives the checkbox column rendered by
// q-table's `selection="multiple"`. The Export button picks this
// up to scope a download to just the selected rows (empty selection
// falls through to "all rows"). Other parents wanting the selection
// can listen to @selection-change.
const selected    = ref([]);

// Re-emit selection upward so the parent (HomePage) can show
// selection-aware UI in its own toolbar if it ever wants to.
watch(selected, (v) => emit("selection-change", v));

// The literal "editor" role can edit. We also let admins through —
// admin is the superset of editor in the app's role model.
const canEdit = computed(() => props.role === "editor" || props.role === "admin");

const filteredRows = computed(() => {
  if (!filter.value) return props.rows;
  const q = filter.value.toLowerCase();
  return props.rows.filter(row =>
    Object.values(row).some(v => String(v ?? "").toLowerCase().includes(q)),
  );
});

function onRun(row)    { emit("run",    row); }
function onStart(row)  { emit("start",  row); }
function onStop(row)   { emit("stop",   row); }
function onEdit(row)   { if (canEdit.value) emit("edit",   row); }
function onDelete(row) { if (canEdit.value) emit("delete", row); }
function onAdd()       { if (canEdit.value) emit("add"); }
// Hand the parent the current selection so it can scope the export
// to "what the user ticked" or fall back to all rows when nothing's
// ticked. We send a fresh array, not the ref, so the parent can
// mutate it safely.
function onExport()    { emit("export", [...selected.value]); }
function onImport()    { if (canEdit.value) emit("import"); }

function onRefresh() {
  if (refreshing.value) return;
  refreshing.value = true;
  emit("refresh");
  // Brief blink so the user sees the click register. Parent owns
  // the actual reload; emit() is fire-and-forget in Vue 3.
  setTimeout(() => { refreshing.value = false; }, 400);
}

// Human label that matches the pill colour. Re-used from
// FlowInspector's triggerStatusLabel so users see the same wording
// across pages.
function triggerStatusLabel(row) {
  if (!row.enabled) return "stopped";
  if (row.last_error) return "failed";
  return "running";
}
</script>

<style scoped>
.row-actions {
  white-space: nowrap;
}
.trigger-pill {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.pill-running { background: var(--success-soft); color: var(--success); }
.pill-failed  { background: var(--danger-soft);  color: var(--danger); }
.pill-stopped { background: rgba(0,0,0,0.06);    color: var(--text-muted); }
</style>
