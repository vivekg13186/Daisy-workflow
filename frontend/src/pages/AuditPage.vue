<!--
  Audit log — admin-only page that browses /api/audit.

  Filters down the top: action prefix, actor, outcome. Cursor
  pagination via the `nextBefore` token the server returns.

  No "edit" or "delete" affordances — audit rows are insert-only
  by design.
-->

<template>
  <div class="page q-pa-md">
    <div class="page-header q-mb-md">
      <div class="text-h6">Audit log</div>
      <div class="text-caption text-grey-7">
        Security-relevant actions in this workspace, newest first.
      </div>
    </div>

    <div class="filters row q-gutter-md q-mb-md items-end">
      <q-input
        v-model="filters.action"
        label="Action prefix"
        dense outlined clearable
        debounce="250"
        placeholder="e.g. auth.login"
        style="min-width: 200px"
        @update:model-value="reload"
      />
      <q-input
        v-model="filters.actor"
        label="Actor (email or id)"
        dense outlined clearable
        debounce="250"
        style="min-width: 220px"
        @update:model-value="reload"
      />
      <q-select
        v-model="filters.outcome"
        :options="outcomeOptions"
        label="Outcome"
        dense outlined clearable
        emit-value map-options
        style="min-width: 140px"
        @update:model-value="reload"
      />
      <q-space />
      <q-btn flat dense icon="refresh" @click="reload">
        <q-tooltip>Reload</q-tooltip>
      </q-btn>
    </div>

    <q-table
      :rows="rows"
      :columns="columns"
      row-key="id"
      :loading="loading"
      :pagination="{ rowsPerPage: 0 }"
      hide-bottom
      flat bordered
    >
      <template #body-cell-outcome="props">
        <q-td :props="props">
          <q-badge
            :color="props.row.outcome === 'success' ? 'positive'
                  : props.row.outcome === 'failed'  ? 'negative'
                  : 'warning'"
            :label="props.row.outcome"
          />
        </q-td>
      </template>
      <template #body-cell-actor="props">
        <q-td :props="props">
          <div>{{ props.row.actor_email || "—" }}</div>
          <div class="text-caption text-grey-7">{{ props.row.actor_role || "" }}</div>
        </q-td>
      </template>
      <template #body-cell-resource="props">
        <q-td :props="props">
          <div v-if="props.row.resource_type">
            <code>{{ props.row.resource_type }}</code>
            <span v-if="props.row.resource_name"> · {{ props.row.resource_name }}</span>
          </div>
          <span v-else class="text-grey-7">—</span>
        </q-td>
      </template>
      <template #body-cell-metadata="props">
        <q-td :props="props">
          <pre v-if="hasMetadata(props.row.metadata)" class="metadata-cell">{{
            JSON.stringify(props.row.metadata, null, 2)
          }}</pre>
          <span v-else class="text-grey-7">—</span>
        </q-td>
      </template>
    </q-table>

    <div class="row q-mt-md">
      <q-space />
      <q-btn
        v-if="nextBefore"
        unelevated color="primary"
        label="Load more"
        :loading="loading"
        @click="loadMore"
      />
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from "vue";
import { useQuasar } from "quasar";
import { Audit } from "../api/client.js";

const $q = useQuasar();

const rows       = ref([]);
const nextBefore = ref(null);
const loading    = ref(false);

const filters = reactive({
  action:  null,
  actor:   null,
  outcome: null,
});

const outcomeOptions = [
  { label: "success", value: "success" },
  { label: "failed",  value: "failed"  },
  { label: "denied",  value: "denied"  },
];

const columns = [
  { name: "created_at", label: "When",     field: "created_at", align: "left",
    format: v => v ? new Date(v).toLocaleString() : "—", style: "width: 180px" },
  { name: "actor",      label: "Actor",    field: "actor_email", align: "left",
    style: "width: 220px" },
  { name: "action",     label: "Action",   field: "action",      align: "left",
    style: "width: 180px" },
  { name: "outcome",    label: "Outcome",  field: "outcome",     align: "left",
    style: "width: 90px" },
  { name: "resource",   label: "Resource", field: "resource_type", align: "left",
    style: "width: 240px" },
  { name: "metadata",   label: "Metadata", field: "metadata",   align: "left" },
  { name: "ip",         label: "IP",       field: "ip",          align: "left",
    style: "width: 140px" },
];

function hasMetadata(m) {
  return m && typeof m === "object" && Object.keys(m).length > 0;
}

function buildParams() {
  const p = {};
  if (filters.action)  p.action  = filters.action.trim();
  if (filters.actor)   p.actor   = filters.actor.trim();
  if (filters.outcome) p.outcome = filters.outcome;
  return p;
}

async function reload() {
  loading.value = true;
  try {
    const data = await Audit.list({ ...buildParams(), limit: 100 });
    rows.value       = data.rows;
    nextBefore.value = data.nextBefore;
  } catch (e) {
    notifyError(e, "Failed to load audit log");
  } finally {
    loading.value = false;
  }
}

async function loadMore() {
  if (!nextBefore.value) return;
  loading.value = true;
  try {
    const data = await Audit.list({
      ...buildParams(), limit: 100, before: nextBefore.value,
    });
    rows.value.push(...data.rows);
    nextBefore.value = data.nextBefore;
  } catch (e) {
    notifyError(e, "Failed to load more rows");
  } finally {
    loading.value = false;
  }
}

onMounted(reload);

function notifyError(e, fallback) {
  const msg = e?.response?.data?.message || e.message || fallback;
  $q.notify({ type: "negative", message: msg, timeout: 4000 });
}
</script>

<style scoped>
.page {
  max-width: 1400px;
  margin: 0 auto;
}
.metadata-cell {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 11px;
  margin: 0;
  white-space: pre-wrap;
  max-width: 360px;
  max-height: 120px;
  overflow: auto;
  background: rgba(0,0,0,0.04);
  padding: 4px 6px;
  border-radius: 4px;
}
</style>
