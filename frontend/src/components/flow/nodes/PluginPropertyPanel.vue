<!--
  Schema-driven property editor. Receives the currently selected VueFlow node
  via the `node` prop and emits `update` with a full data object whenever any
  field changes. The parent (CanvasTab) calls `useVueFlow().updateNode(id, …)`
  to push the change back into the VueFlow store.

  The panel reads node.data.plugin (the live plugin metadata captured when
  the node was created) so the inputs/outputs editors can be tailored to the
  action's schema.
-->
<template>
  <div class="q-pa-md column q-gutter-sm">
    <div class="row items-center q-mb-xs">
      <q-icon name="settings" class="q-mr-sm" />
      <div class="text-subtitle2">{{ node.data.action || "node" }}</div>
    </div>

    <q-input
      :model-value="node.data.name"
      @update:model-value="set('name', $event)"
      dense filled label="Name *"
      :error="!node.data.name"
      error-message="required"
    />

    <q-input
      :model-value="node.data.description"
      @update:model-value="set('description', $event)"
      dense filled label="Description"
      type="textarea" autogrow
    />

    <!-- Inputs ─ schema-aware where possible, free-form for unknowns -->
    <q-card flat bordered>
      <q-card-section class="q-pa-sm">
        <div class="row items-center">
          <div class="text-caption text-grey">Inputs</div>
          <q-space />
          <q-btn dense flat size="sm" no-caps icon="add" label="Field" @click="addCustomInput" />
        </div>

        <!-- Schema-required inputs first (always shown) -->
        <div v-for="key in requiredInputKeys" :key="`req-${key}`" class="row q-col-gutter-xs items-center q-mb-xs">
          <div class="col-4 text-caption">{{ key }}<span class="text-red">*</span></div>
          <div class="col-8">
            <q-input
              dense outlined
              :model-value="node.data.inputs?.[key]"
              @update:model-value="setInput(key, $event)"
              :placeholder="hintFor(key)"
            />
          </div>
        </div>

        <!-- Custom / extra keys -->
        <div v-for="row in customInputRows" :key="`ci-${row._k}`" class="row q-col-gutter-xs items-center q-mb-xs">
          <div class="col-4">
            <q-input dense outlined v-model="row.k" placeholder="key" @update:model-value="syncCustomInputs" />
          </div>
          <div class="col-7">
            <q-input dense outlined v-model="row.v" placeholder="value or ${expr}" @update:model-value="syncCustomInputs" />
          </div>
          <div class="col-1 text-right">
            <q-btn dense flat round size="sm" icon="delete" color="negative" @click="removeCustomInput(row._k)" />
          </div>
        </div>
      </q-card-section>
    </q-card>

    <!-- Outputs (pluginField → ctxVar) -->
    <q-card flat bordered>
      <q-card-section class="q-pa-sm">
        <div class="row items-center">
          <div class="text-caption text-grey">Outputs <span class="text-grey">(plugin field → ctx var)</span></div>
          <q-space />
          <q-btn dense flat size="sm" no-caps icon="add" label="Field" @click="addOutput" />
        </div>
        <div v-for="row in outputRows" :key="`out-${row._k}`" class="row q-col-gutter-xs items-center q-mb-xs">
          <div class="col-5">
            <q-input dense outlined v-model="row.k" placeholder="pluginField (e.g. body.id)" @update:model-value="syncOutputs" />
          </div>
          <div class="col-6">
            <q-input dense outlined v-model="row.v" placeholder="ctxVar" @update:model-value="syncOutputs" />
          </div>
          <div class="col-1 text-right">
            <q-btn dense flat round size="sm" icon="delete" color="negative" @click="removeOutput(row._k)" />
          </div>
        </div>
      </q-card-section>
    </q-card>

    <q-input
      :model-value="node.data.executeIf"
      @update:model-value="set('executeIf', $event)"
      dense filled label="executeIf"
      hint="Optional. ${expr} — node is skipped when false."
    />

    <div class="row q-col-gutter-sm">
      <div class="col-4">
        <q-input
          :model-value="node.data.retry"
          @update:model-value="set('retry', Number($event) || 0)"
          dense filled type="number" label="retry"
        />
      </div>
      <div class="col-4">
        <q-input
          :model-value="node.data.retryDelay"
          @update:model-value="set('retryDelay', $event)"
          dense filled label="retryDelay" hint="ms or 500ms / 2s"
        />
      </div>
      <div class="col-4">
        <q-select
          :model-value="node.data.onError"
          @update:model-value="set('onError', $event)"
          dense filled label="onError"
          :options="['continue','terminate']"
        />
      </div>
    </div>

    <q-input
      :model-value="node.data.batchOver"
      @update:model-value="set('batchOver', $event)"
      dense filled label="batchOver"
      hint="Optional ${array} — runs the action once per item."
    />
  </div>
</template>

<script setup>
import { computed, ref, watch } from "vue";

const props = defineProps({
  node: { type: Object, required: true },
});
const emit = defineEmits(["update"]);

// Schema lookups (cached per node selection).
const schema = computed(() => props.node.data?.plugin?.inputSchema || {});
const requiredInputKeys = computed(() => schema.value.required || []);

function hintFor(key) {
  const def = schema.value.properties?.[key];
  if (!def) return "";
  if (def.description) return def.description;
  if (def.type) return `type: ${def.type}`;
  return "";
}

// Build the "patch + emit" helper. We never mutate `props.node.data` directly —
// always emit a fresh data object so the parent's updateNode() takes effect.
function patch(patchObj) {
  emit("update", { ...props.node.data, ...patchObj });
}
function set(key, value) { patch({ [key]: value }); }
function setInput(key, value) {
  patch({ inputs: { ...(props.node.data.inputs || {}), [key]: value } });
}

// ─── Custom input rows (everything not in schema.required) ──────────────────
const customInputRows = ref([]);
function rebuildCustomRows() {
  const reqSet = new Set(requiredInputKeys.value);
  customInputRows.value = Object.entries(props.node.data.inputs || {})
    .filter(([k]) => !reqSet.has(k))
    .map(([k, v]) => ({ _k: k, k, v: typeof v === "string" ? v : JSON.stringify(v) }));
}
watch(() => props.node, rebuildCustomRows, { immediate: true });

function addCustomInput() {
  customInputRows.value.push({ _k: `_${Date.now()}`, k: "", v: "" });
}
function removeCustomInput(_k) {
  customInputRows.value = customInputRows.value.filter(r => r._k !== _k);
  syncCustomInputs();
}
function syncCustomInputs() {
  const inputs = {};
  // Keep required values
  const reqSet = new Set(requiredInputKeys.value);
  for (const k of reqSet) {
    if (props.node.data.inputs?.[k] !== undefined) inputs[k] = props.node.data.inputs[k];
  }
  // Add custom rows
  for (const r of customInputRows.value) {
    if (!r.k) continue;
    let v = r.v;
    if (typeof v === "string" && /^[\s]*[{\[\d-]/.test(v)) {
      try { v = JSON.parse(v); } catch { /* keep as string */ }
    }
    inputs[r.k] = v;
  }
  patch({ inputs });
}

// ─── Output rows ────────────────────────────────────────────────────────────
const outputRows = ref([]);
function rebuildOutputRows() {
  outputRows.value = Object.entries(props.node.data.outputs || {})
    .map(([k, v]) => ({ _k: k, k, v }));
}
watch(() => props.node, rebuildOutputRows, { immediate: true });

function addOutput() { outputRows.value.push({ _k: `_${Date.now()}`, k: "", v: "" }); }
function removeOutput(_k) {
  outputRows.value = outputRows.value.filter(r => r._k !== _k);
  syncOutputs();
}
function syncOutputs() {
  const outputs = {};
  for (const r of outputRows.value) {
    if (!r.k) continue;
    outputs[r.k] = r.v;
  }
  patch({ outputs });
}
</script>
