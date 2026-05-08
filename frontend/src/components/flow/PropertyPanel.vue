<!--
  Right pane in the canvas tab. Edits the currently-selected node. v-model is
  the node object — the parent updates its model.nodes array on each change.
-->
<template>
  <div v-if="!node" class="empty-pane q-pa-md text-caption text-grey">
    Select a node on the canvas to edit its properties, or click a plugin in the
    palette to add a new one.
  </div>

  <div v-else class="prop-pane column q-pa-md q-gutter-sm">
    <div class="row items-center">
      <div class="text-subtitle2">{{ node.name || "(unnamed)" }}</div>
      <q-space />
      <q-btn dense flat round icon="delete" color="negative" size="sm" @click="$emit('delete')">
        <q-tooltip>Delete node</q-tooltip>
      </q-btn>
    </div>

    <q-input :model-value="node.name" @update:model-value="set('name', $event)"
             dense filled label="Name *"
             :error="!node.name" error-message="required" />

    <q-select :model-value="node.action" @update:model-value="set('action', $event)"
              dense filled label="Action *"
              :options="pluginNames" use-input fill-input hide-selected
              input-debounce="0" @filter="filterPlugins"
              :error="!node.action" error-message="required" />

    <q-input :model-value="node.description" @update:model-value="set('description', $event)"
             dense filled label="Description" />

    <!-- inputs key/value editor -->
    <q-card flat bordered>
      <q-card-section class="q-pa-sm">
        <div class="row items-center">
          <div class="text-caption text-grey">Inputs</div>
          <q-space />
          <q-btn dense flat icon="add" no-caps size="sm" label="Add" @click="addInput" />
        </div>
        <div v-for="(row, i) in inputRows" :key="`in-${i}`" class="row q-col-gutter-xs items-center q-mb-xs">
          <div class="col-4">
            <q-input dense outlined v-model="row.k" placeholder="key" @update:model-value="syncInputs" />
          </div>
          <div class="col-7">
            <q-input dense outlined v-model="row.v" placeholder="value or ${expr}" @update:model-value="syncInputs" />
          </div>
          <div class="col-1 text-right">
            <q-btn dense flat round size="sm" icon="delete" color="negative" @click="removeInput(i)" />
          </div>
        </div>
      </q-card-section>
    </q-card>

    <!-- outputs key/value editor (pluginField → ctxVar) -->
    <q-card flat bordered>
      <q-card-section class="q-pa-sm">
        <div class="row items-center">
          <div class="text-caption text-grey">Outputs <span class="text-grey">(plugin field → ctx var)</span></div>
          <q-space />
          <q-btn dense flat icon="add" no-caps size="sm" label="Add" @click="addOutput" />
        </div>
        <div v-for="(row, i) in outputRows" :key="`out-${i}`" class="row q-col-gutter-xs items-center q-mb-xs">
          <div class="col-5">
            <q-input dense outlined v-model="row.k" placeholder="pluginField (e.g. body.id)" @update:model-value="syncOutputs" />
          </div>
          <div class="col-6">
            <q-input dense outlined v-model="row.v" placeholder="ctxVar" @update:model-value="syncOutputs" />
          </div>
          <div class="col-1 text-right">
            <q-btn dense flat round size="sm" icon="delete" color="negative" @click="removeOutput(i)" />
          </div>
        </div>
      </q-card-section>
    </q-card>

    <q-input :model-value="node.executeIf" @update:model-value="set('executeIf', $event)"
             dense filled label="executeIf"
             hint="Optional. ${expr} — node is skipped when false." />

    <div class="row q-col-gutter-sm">
      <div class="col-4">
        <q-input :model-value="node.retry" @update:model-value="set('retry', Number($event) || 0)"
                 dense filled type="number" label="retry" />
      </div>
      <div class="col-4">
        <q-input :model-value="node.retryDelay" @update:model-value="set('retryDelay', $event)"
                 dense filled label="retryDelay" hint="ms or 500ms / 2s" />
      </div>
      <div class="col-4">
        <q-select :model-value="node.onError" @update:model-value="set('onError', $event)"
                  dense filled label="onError"
                  :options="['continue','terminate']" />
      </div>
    </div>

    <q-input :model-value="node.batchOver" @update:model-value="set('batchOver', $event)"
             dense filled label="batchOver"
             hint="Optional ${array} — runs the action once per item." />
  </div>
</template>

<script setup>
import { ref, watch, computed } from "vue";

const props = defineProps({
  node:    { type: Object, default: null },
  plugins: { type: Array,  default: () => [] },
});
const emit = defineEmits(["update:node", "delete"]);

const pluginNamesAll = computed(() => props.plugins.map(p => p.name));
const pluginNames = ref([...pluginNamesAll.value]);
function filterPlugins(val, update) {
  update(() => {
    const f = (val || "").toLowerCase();
    pluginNames.value = pluginNamesAll.value.filter(n => n.toLowerCase().includes(f));
  });
}

function set(key, value) {
  emit("update:node", { ...props.node, [key]: value });
}

// ----- inputs/outputs key-value mirrors -----
const inputRows  = ref(toRows(props.node?.inputs));
const outputRows = ref(toRows(props.node?.outputs));

watch(() => props.node, (n) => {
  inputRows.value  = toRows(n?.inputs);
  outputRows.value = toRows(n?.outputs);
});

function toRows(obj) {
  if (!obj || typeof obj !== "object") return [];
  return Object.entries(obj).map(([k, v]) => ({
    k,
    v: typeof v === "string" ? v : JSON.stringify(v),
  }));
}
function fromRows(rows) {
  const out = {};
  for (const r of rows) {
    if (!r.k) continue;
    let v = r.v;
    // If looks like JSON object/array/number/boolean, parse it.
    if (typeof v === "string" && /^[\s]*[{\[\d-]/.test(v)) {
      try { v = JSON.parse(v); } catch { /* keep as string */ }
    }
    out[r.k] = v;
  }
  return out;
}
function syncInputs()  { set("inputs",  fromRows(inputRows.value)); }
function syncOutputs() { set("outputs", fromRows(outputRows.value)); }

function addInput()    { inputRows.value.push({ k: "", v: "" });  syncInputs(); }
function addOutput()   { outputRows.value.push({ k: "", v: "" }); syncOutputs(); }
function removeInput(i)  { inputRows.value.splice(i, 1); syncInputs(); }
function removeOutput(i) { outputRows.value.splice(i, 1); syncOutputs(); }
</script>

<style scoped>
.empty-pane { background: var(--panel); height: 100%; }
.prop-pane  { background: var(--panel); height: 100%; overflow-y: auto; }
</style>
