<script setup>
import { computed } from "vue";

const props = defineProps({
  // The `nodes` object from execution.context (engine's per-node summary).
  // Shape: { [nodeName]: { status, output, startedAt, finishedAt, attempts, error? } }
  ctxNodes: { type: Object, default: () => ({}) },
});

const rows = computed(() =>
  Object.entries(props.ctxNodes || {}).map(([name, n]) => ({
    name,
    status:     n?.status ?? "—",
    attempts:   n?.attempts ?? 1,
    startedAt:  n?.startedAt ?? null,
    finishedAt: n?.finishedAt ?? null,
    output:     n?.output,
    error:      n?.error,
  }))
);

const columns = [
  { name: "name",     label: "Node",     field: "name",     align: "left", sortable: true },
  { name: "status",   label: "Status",   field: "status",   align: "left" },
  { name: "attempts", label: "Attempts", field: "attempts", align: "right", style: "width: 70px;" },
  { name: "startedAt",  label: "Started",  field: "startedAt",
    format: v => v ? new Date(v).toLocaleTimeString() : "" },
  { name: "finishedAt", label: "Finished", field: "finishedAt",
    format: v => v ? new Date(v).toLocaleTimeString() : "" },
  { name: "outerr", label: "Output / Error",
    field: r => r.error || r.output, align: "left" },
];

function fmt(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}
</script>

<template>
  <q-table
    dense flat square
    :rows="rows"
    :columns="columns"
    row-key="name"
    :rows-per-page-options="[0]"
    hide-pagination
    hide-bottom
    no-data-label="No node records yet — execution still pending."
    class="dense-table"
  >
    <template v-slot:header="props">
      <q-tr :props="props">
        <q-th auto-width />
        <q-th v-for="col in props.cols" :key="col.name" :props="props">
          {{ col.label }}
        </q-th>
      </q-tr>
    </template>

    <template v-slot:body="props">
      <q-tr :props="props">
        <q-td auto-width>
          <q-btn
            size="sm" flat round dense
            :icon="props.expand ? 'expand_less' : 'expand_more'"
            @click="props.expand = !props.expand"
          />
        </q-td>
        <q-td v-for="col in props.cols" :key="col.name" :props="props">
          <span
            v-if="col.name === 'status'"
            class="status-pill"
            :class="`status-${props.row.status}`"
          >{{ props.row.status }}</span>
          <div v-else-if="col.name === 'outerr'" class="ellipsis" style="max-width: 320px;">
            {{ fmt(props.row.error || props.row.output).slice(0, 200) }}
          </div>
          <template v-else>{{ col.value }}</template>
        </q-td>
      </q-tr>
      <q-tr v-show="props.expand" :props="props" no-hover>
        <q-td colspan="100%">
          <div v-if="props.row.error" class="exp-block">
            <div class="exp-label">Error</div>
            <pre class="cell-pre">{{ props.row.error }}</pre>
          </div>
          <div v-if="props.row.output != null" class="exp-block">
            <div class="exp-label">Output</div>
            <pre class="cell-pre">{{ fmt(props.row.output) }}</pre>
          </div>
        </q-td>
      </q-tr>
    </template>
  </q-table>
</template>

<style scoped>
.cell-pre {
  margin: 0;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 11.5px;
  white-space: pre-wrap;
  word-break: break-word;
  max-width: 100%;
}
.exp-block { margin: 4px 0; }
.exp-label {
  font-size: 10px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-bottom: 2px;
}
</style>
