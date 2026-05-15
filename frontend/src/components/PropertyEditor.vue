<!--
  Generic schema-driven property editor (Quasar).

  Used by the FlowDesigner's right-side node panel, but kept generic so
  any caller can render a form by supplying a `schema` array + a v-model
  data object. The editor never owns its own data — every change is
  emitted upward via update:modelValue, so the caller can persist
  anywhere it likes (auto-save, debounced extract, etc.).

  ── Schema shape ──────────────────────────────────────────────────────
  schema = [
    {
      name: "Inputs",                  // panel title (q-expansion-item)
      collapsed: false,                // optional, default false
      children: [
        {
          ui_type: "input",            // input | textarea | select | toggle |
                                       // list | table | keyvalues
          label:   "URL",              // user-facing label
          bind:    "inputs.url",       // dotted path into the modelValue
          type:    "text" | "number" | "url" | "email" | "password",
          hint:    "optional helper text",
          options: ["GET", "POST"],    // ui_type=select
          validation: {                // optional, all keys optional
            required: true,
            url:      true,
            min:      0,
            max:      100,
            minItems: 1,
          },
          columns: {                   // ui_type=table
            <colKey>: {
              name:    <colKey>,
              field:   <colKey>,
              label:   "Display",
              ui_type: "input" | "select" | "toggle",
              type:    "text" | "number",
              options: [...],
              validation: { ... },
            },
          },
        },
        ...
      ],
    },
    ...
  ];

  ── Bind paths ────────────────────────────────────────────────────────
  `bind` is a dotted path into modelValue: "name", "inputs.url",
  "outputs.result.body". Path nodes are auto-created when written.
-->
<template>
  <q-form ref="formRef" class="property-editor column q-gutter-none">
    <q-expansion-item
      v-for="panel in schema"
      :key="panel.name"
      :label="panel.name"
      :default-opened="panel.collapsed !== true"
      dense
      expand-separator
      header-class="app-section-header"
    >
      <div class="q-pa-sm column q-gutter-sm">
        <template v-for="item in panel.children" :key="item.bind">

          <!-- INPUT (text / number / url / email / password) -->
          <div v-if="item.ui_type === 'input'">
            <q-input
              outlined dense
              :model-value="get(item.bind)"
              @update:model-value="set(item.bind, coerce(item, $event))"
              :label="item.label"
              :type="item.type || 'text'"
              :rules="buildRules(item.validation, item)"
              lazy-rules
            />
            <div v-if="item.hint" class="prop-hint">{{ item.hint }}</div>
          </div>

          <!-- TEXTAREA -->
          <div v-else-if="item.ui_type === 'textarea'">
            <q-input
              outlined dense type="textarea" autogrow
              :model-value="get(item.bind)"
              @update:model-value="set(item.bind, $event)"
              :label="item.label"
              :placeholder="item.placeholder"
              :rules="buildRules(item.validation, item)"
              lazy-rules
              input-style="font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; min-height: 60px; white-space: pre;"
            />
            <div v-if="item.hint" class="prop-hint">{{ item.hint }}</div>
          </div>

          <!-- SELECT -->
          <div v-else-if="item.ui_type === 'select'">
            <q-select
              outlined dense emit-value map-options
              :model-value="get(item.bind)"
              @update:model-value="set(item.bind, $event)"
              :options="normalizeOptions(item.options)"
              :label="item.label"
              :rules="buildRules(item.validation, item)"
              lazy-rules
            />
            <div v-if="item.hint" class="prop-hint">{{ item.hint }}</div>
          </div>

          <!-- TOGGLE (boolean) -->
          <div v-else-if="item.ui_type === 'toggle'">
            <q-toggle
              :model-value="!!get(item.bind)"
              @update:model-value="set(item.bind, $event)"
              :label="item.label"
              color="primary"
              left-label
              dense
            />
            <div v-if="item.hint" class="prop-hint">{{ item.hint }}</div>
          </div>

          <!-- LIST (array of strings) -->
          <div v-else-if="item.ui_type === 'list'">
            <div class="row items-center q-mb-xs">
              <div class="text-caption text-muted col">{{ item.label }}</div>
              <q-btn flat dense size="sm" no-caps icon="add" label="add" color="primary"
                     @click="addListItem(item.bind)" />
            </div>
            <div v-for="(_, i) in (get(item.bind) || [])" :key="`${item.bind}-${i}`"
                 class="row q-col-gutter-xs items-center q-mb-xs">
              <div class="col">
                <q-input outlined dense
                         :model-value="(get(item.bind) || [])[i]"
                         @update:model-value="setListItem(item.bind, i, $event)" />
              </div>
              <div class="col-auto">
                <q-btn flat round dense size="sm" icon="delete" color="negative"
                       @click="removeListItem(item.bind, i)" />
              </div>
            </div>
            <div v-if="!(get(item.bind) || []).length" class="text-caption text-muted q-pa-xs">
              No items.
            </div>
          </div>

          <!-- INFO (read-only label/value rows, e.g. plugin Returns docs) -->
          <div v-else-if="item.ui_type === 'info'" class="info-block">
            <div v-if="item.hint" class="text-caption text-muted q-mb-xs">
              {{ item.hint }}
            </div>
            <div v-for="row in item.rows || []" :key="row.label" class="info-row">
              <code class="info-key">{{ row.label }}</code>
              <span  class="info-val">{{ row.value }}</span>
            </div>
            <div v-if="!(item.rows || []).length" class="text-caption text-muted">
              (no fields)
            </div>
          </div>

          <!-- KEY/VALUES (dynamic key/value pairs, e.g. node outputs).
               The schema item may set `keyPlaceholder` / `valuePlaceholder`
               to label the columns; falls back to "key" / "value". -->
          <div v-else-if="item.ui_type === 'keyvalues'">
            <div class="row items-center q-mb-xs">
              <div class="text-caption text-muted col">{{ item.label }}</div>
              <q-btn flat dense size="sm" no-caps icon="add" label="add" color="primary"
                     @click="addKvRow(item.bind)" />
            </div>
            <div v-for="row in kvRows(item.bind)" :key="row._k"
                 class="row q-col-gutter-xs items-center q-mb-xs">
              <div class="col-5">
                <q-input outlined dense
                         :placeholder="item.keyPlaceholder || 'key'"
                         v-model="row.k" @update:model-value="syncKv(item.bind)" />
              </div>
              <div class="col-6">
                <q-input outlined dense
                         :placeholder="item.valuePlaceholder || 'value'"
                         v-model="row.v" @update:model-value="syncKv(item.bind)" />
              </div>
              <div class="col-1 text-right">
                <q-btn flat round dense size="sm" icon="delete" color="negative"
                       @click="removeKvRow(item.bind, row._k)" />
              </div>
            </div>
            <div v-if="!kvRows(item.bind).length" class="text-caption text-muted q-pa-xs">
              No entries.
            </div>
          </div>

          <!-- TABLE (array of objects with fixed columns) -->
          <div v-else-if="item.ui_type === 'table'">
            <q-table
              flat bordered dense
              :title="item.label"
              :columns="tableColumns(item.columns)"
              :rows="get(item.bind) || []"
              :row-key="(_, i) => i"
              hide-bottom
              :rows-per-page-options="[0]"
              class="property-table"
            >
              <template #top-right>
                <q-btn flat dense round size="sm" icon="add" color="primary"
                       @click="addRow(item)">
                  <q-tooltip>Add row</q-tooltip>
                </q-btn>
              </template>

              <template #body="props">
                <q-tr :props="props">
                  <q-td v-for="col in props.cols" :key="col.name" :props="props">
                    <template v-if="col.field === '__actions'">
                      <q-btn flat round dense size="sm" icon="delete" color="negative"
                             @click="removeRow(item.bind, props.rowIndex)">
                        <q-tooltip>Remove row</q-tooltip>
                      </q-btn>
                    </template>
                    <template v-else>
                      <q-toggle
                        v-if="col.ui_type === 'toggle'"
                        dense
                        :model-value="!!props.row[col.field]"
                        @update:model-value="updateCell(item.bind, props.rowIndex, col.field, $event)"
                      />
                      <q-select
                        v-else-if="col.ui_type === 'select'"
                        dense borderless emit-value map-options
                        :model-value="props.row[col.field]"
                        :options="normalizeOptions(col.options)"
                        @update:model-value="updateCell(item.bind, props.rowIndex, col.field, $event)"
                      />
                      <q-input
                        v-else
                        dense borderless
                        :model-value="props.row[col.field]"
                        :type="col.type || 'text'"
                        @update:model-value="updateCell(item.bind, props.rowIndex, col.field, coerceCol(col, $event))"
                        :rules="buildRules(col.validation, col)"
                        lazy-rules
                      />
                    </template>
                  </q-td>
                </q-tr>
              </template>
            </q-table>
          </div>

        </template>
      </div>
    </q-expansion-item>
  </q-form>
</template>

<script setup>
import { ref, reactive, watch } from "vue";

const props = defineProps({
  schema:     { type: Array,  required: true },
  modelValue: { type: Object, required: true },
});
const emit = defineEmits(["update:modelValue"]);

const formRef = ref();

// ── Local draft -----------------------------------------------------------
// We keep an editable draft so v-model edits don't fight with parent
// reactivity. Whenever the parent replaces the modelValue object outright
// (e.g. a different node was selected) we re-clone. In-place edits flow
// through emit("update:modelValue") and the parent re-uses our reference.
const draft = ref(deepClone(props.modelValue));

// Shadow store of key/value rows for ui_type === "keyvalues". Vue can't
// v-model an object's keys directly, so we mirror them into arrays of
// { _k, k, v } rows and sync back on every edit. Must be reactive() so
// `addKvRow` / `removeKvRow` push/splice trigger re-renders — using a
// plain Map here meant the "+ add" button did nothing visible.
const kvShadow = reactive({});  // { [bindPath]: [{ _k, k, v }] }

watch(() => props.modelValue, (next) => {
  if (next === draft.value) return;          // we were the source of the change
  draft.value = deepClone(next);
  // The new draft has its own outputs/keyvalues — drop any stale rows
  // from the previously-selected node so we rebuild from scratch on the
  // next render pass.
  for (const k of Object.keys(kvShadow)) delete kvShadow[k];
});

// ── Helpers --------------------------------------------------------------
function deepClone(v) {
  try { return JSON.parse(JSON.stringify(v ?? {})); } catch { return { ...(v ?? {}) }; }
}

function getPath(obj, path) {
  if (!path) return obj;
  const parts = String(path).split(".");
  let cur = obj;
  for (const p of parts) { if (cur == null) return undefined; cur = cur[p]; }
  return cur;
}
function setPath(obj, path, value) {
  if (!path) return;
  const parts = String(path).split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (cur[k] == null || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
}

function get(bind)        { return getPath(draft.value, bind); }
function set(bind, value) { setPath(draft.value, bind, value); emitDraft(); }

function emitDraft() {
  // Emit the SAME reference, not a deep clone. The watcher above bails out
  // when `props.modelValue === draft.value`, which keeps the kv shadow
  // intact between keystrokes — re-seeding it would generate fresh `_k`
  // values per row and Vue would destroy & re-create every <q-input>,
  // costing the user their focus on every character they type.
  // The parent (PluginPropertyPanel) already snapshots the value when it
  // forwards the change to the canvas, so a shared reference here is safe.
  emit("update:modelValue", draft.value);
}

// Coerce a string value into the schema's expected type (mainly for
// q-input which always reports strings). Numbers become Number(); empty
// becomes undefined so we don't pollute the payload.
//
// Both helpers tolerate `item` / `col` being null or undefined — Quasar's
// internals occasionally call render-time bindings before our v-for has
// re-stabilised, and we'd rather pass values through than throw.
function coerce(item, value) {
  if (value === "" || value === null || value === undefined) return undefined;
  if (item && (item.type === "number" || item.type === "integer")) {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return value;
}
function coerceCol(col, value) {
  if (col && (col.type === "number" || col.type === "integer")) {
    if (value === "" || value === null) return undefined;
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  if (value === "" || value === null) return undefined;
  return value;
}

// ── List helpers (array of strings) ─────────────────────────────────────
function ensureList(bind) {
  let cur = getPath(draft.value, bind);
  if (!Array.isArray(cur)) {
    cur = [];
    setPath(draft.value, bind, cur);
  }
  return cur;
}
function addListItem(bind)         { ensureList(bind).push(""); emitDraft(); }
function setListItem(bind, i, val) { ensureList(bind)[i] = val; emitDraft(); }
function removeListItem(bind, i)   { ensureList(bind).splice(i, 1); emitDraft(); }

// ── Key/value helpers ───────────────────────────────────────────────────
function kvRows(bind) {
  // Lazy-seed from the bound object on first access.
  if (!kvShadow[bind]) {
    const obj = getPath(draft.value, bind) || {};
    kvShadow[bind] = Object.entries(obj).map(([k, v]) => ({
      _k: `_${k}_${Math.random().toString(16).slice(2, 6)}`, k, v,
    }));
  }
  return kvShadow[bind];
}
function addKvRow(bind) {
  // Pushing into a reactive array triggers v-for to re-render. Don't sync
  // yet — an empty key would be filtered out at the next syncKv() anyway.
  kvRows(bind).push({
    _k: `_${Date.now()}_${Math.random().toString(16).slice(2, 4)}`,
    k:  "",
    v:  "",
  });
}
function removeKvRow(bind, _k) {
  kvShadow[bind] = (kvShadow[bind] || []).filter(r => r._k !== _k);
  syncKv(bind);
}
function syncKv(bind) {
  const rows = kvShadow[bind] || [];
  const out = {};
  for (const r of rows) {
    if (!r.k) continue;
    out[r.k] = r.v;
  }
  setPath(draft.value, bind, out);
  emitDraft();
}

// ── Table helpers ───────────────────────────────────────────────────────
function tableColumns(columns) {
  // `columns` is the per-table-column map. Defensive against undefined
  // entries or missing required keys — drop anything that doesn't carry
  // at least a name/field, otherwise q-table downstream blows up on
  // null cell descriptors.
  const cols = Object.values(columns || {})
    .filter(c => c && (c.name || c.field))
    .map(c => ({
      name:  c.name  ?? c.field,
      field: c.field ?? c.name,
      label: c.label ?? c.name ?? c.field,
      align: c.align ?? "left",
      ui_type:    c.ui_type,
      options:    c.options,
      type:       c.type,
      validation: c.validation,
    }));
  cols.push({
    name: "__actions", field: "__actions", label: "", align: "right",
    style: "width: 36px;",
  });
  return cols;
}

function ensureTable(bind) {
  let cur = getPath(draft.value, bind);
  if (!Array.isArray(cur)) {
    cur = [];
    setPath(draft.value, bind, cur);
  }
  return cur;
}
function addRow(item) {
  const row = {};
  for (const [k, col] of Object.entries(item.columns || {})) {
    if (col.ui_type === "toggle") row[k] = false;
    else if (col.type === "number" || col.type === "integer") row[k] = 0;
    else row[k] = "";
  }
  ensureTable(item.bind).push(row);
  emitDraft();
}
function removeRow(bind, index) {
  const t = ensureTable(bind);
  t.splice(index, 1);
  emitDraft();
}
function updateCell(bind, rowIndex, field, value) {
  const t = ensureTable(bind);
  const row = t[rowIndex];
  if (!row) return;
  if (value === undefined || value === "") {
    delete row[field];
  } else {
    row[field] = value;
  }
  emitDraft();
}

// ── Validation rules (Quasar lazy-rules format) ──────────────────────────
function buildRules(validation = {}, item = {}) {
  const rules = [];
  const labelOf = (i) => i.label || i.name || "value";

  if (validation.required) {
    rules.push(v => {
      const empty = v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
      return empty ? `${labelOf(item)} is required` : true;
    });
  }
  if (validation.url) {
    rules.push(v => !v || /^https?:\/\/.+/.test(v) || "Invalid URL");
  }
  if (validation.min !== undefined) {
    rules.push(v => v === undefined || v === null || v === "" || Number(v) >= validation.min || `Minimum is ${validation.min}`);
  }
  if (validation.max !== undefined) {
    rules.push(v => v === undefined || v === null || v === "" || Number(v) <= validation.max || `Maximum is ${validation.max}`);
  }
  if (validation.minItems !== undefined) {
    rules.push(v => Array.isArray(v) && v.length >= validation.minItems || `At least ${validation.minItems} item(s) required`);
  }
  return rules;
}

function normalizeOptions(options = []) {
  if (!Array.isArray(options)) return [];
  return options.map(v => (v && typeof v === "object") ? v : { label: String(v), value: v });
}

// Allow parent components to trigger validation on demand.
defineExpose({
  validate:        () => formRef.value?.validate(),
  resetValidation: () => formRef.value?.resetValidation(),
});
</script>

<style scoped>
.property-editor {
  background: var(--surface);
}
.text-muted { color: var(--text-muted); }

.property-editor :deep(.q-expansion-item__container > .q-item) {
  min-height: 32px;
  padding: 4px 12px;
}
.property-editor :deep(.q-field--outlined .q-field__control) {
  background: var(--surface);
}
.property-editor :deep(.q-field__label) { font-size: 11.5px; }
.property-editor :deep(.q-field__native) { font-size: 12px; }

/* External hint rendered as a sibling below the field.
   Quasar's built-in `hint` prop puts the text in an absolutely-
   positioned `q-field__bottom` with a fixed reservation slot (~18px in
   dense mode). Any hint over ~2 lines either clips or visually
   collides with the next field. Rendering the hint as a plain sibling
   div instead keeps it in normal flow — wraps as far as it needs and
   pushes the next field down naturally. */
.prop-hint {
  font-size: 11px;
  line-height: 1.4;
  color: var(--text-muted);
  padding: 2px 2px 0;
  white-space: normal;
  word-break: break-word;
}

.property-table :deep(thead th) {
  background: var(--surface-2);
  color: var(--text-muted);
  font-size: 11px;
}
.property-table :deep(tbody td) { padding: 0 6px; font-size: 12px; }

/* `info` ui_type — read-only key/value documentation rows. */
.info-block { padding: 4px 0; }
.info-row {
  display: flex;
  gap: 8px;
  padding: 2px 0;
  font-size: 11.5px;
  align-items: baseline;
  border-bottom: 1px dashed var(--border);
}
.info-row:last-child { border-bottom: 0; }
.info-key {
  flex: 0 0 32%;
  color: var(--primary);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  background: var(--primary-soft);
  padding: 0 4px;
  border-radius: 3px;
}
.info-val {
  flex: 1 1 auto;
  color: var(--text-muted);
}
</style>
