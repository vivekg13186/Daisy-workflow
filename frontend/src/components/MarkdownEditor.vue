<!--
  MarkdownEditor — write markdown on the left, preview on the right.

  Three modes selectable via the toolbar:
    • Edit    — textarea only, full width.
    • Split   — textarea left, preview right (default).
    • Preview — preview only, full width.

  Rendered output uses `marked`. We don't sanitise because the input is
  always the user's own content and never rendered for anyone else; if
  this component starts handling untrusted markdown later, swap in a
  sanitiser (DOMPurify) on the rendered HTML.
-->
<template>
  <div class="md-editor column no-wrap">
    <!-- Toolbar — mode toggle + label + error/hint summary on the right -->
    <div class="md-toolbar row items-center q-px-sm q-py-xs">
      <span v-if="label" class="md-label">{{ label }}{{ required ? " *" : "" }}</span>
      <q-space />
      <q-btn-toggle
        v-model="mode"
        :options="modeOptions"
        size="sm"
        no-caps unelevated dense
        toggle-color="primary"
        class="md-mode-toggle"
      />
    </div>

    <!-- Body — three layouts depending on `mode` -->
    <div
      class="md-body row no-wrap"
      :style="{ minHeight: minHeight + 'px' }"
    >
      <textarea
        v-if="mode !== 'preview'"
        ref="textareaEl"
        :value="modelValue"
        :placeholder="placeholder"
        class="md-textarea col"
        :class="{ 'md-half': mode === 'split' }"
        :style="{ minHeight: minHeight + 'px' }"
        @input="onInput"
      ></textarea>
      <div
        v-if="mode !== 'edit'"
        class="md-preview col"
        :class="{ 'md-half': mode === 'split' }"
        :style="{ minHeight: minHeight + 'px' }"
      >
        <div v-if="modelValue" class="md-rendered" v-html="renderedHtml"></div>
        <div v-else class="md-empty">Nothing to preview yet.</div>
      </div>
    </div>

    <!-- Hint + error footer to mirror q-input affordances -->
    <div v-if="error || hint" class="md-foot row items-center q-px-sm q-py-xs">
      <span v-if="error" class="md-error">{{ errorMessage }}</span>
      <span v-else-if="hint" class="md-hint">{{ hint }}</span>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from "vue";
import { marked } from "marked";

const props = defineProps({
  modelValue:   { type: String, default: "" },
  label:        { type: String, default: "" },
  required:     { type: Boolean, default: false },
  hint:         { type: String, default: "" },
  error:        { type: Boolean, default: false },
  errorMessage: { type: String, default: "" },
  placeholder:  { type: String, default: "" },
  minHeight:    { type: Number, default: 260 },
  // Initial mode the editor opens in. Persists per-component-instance only.
  defaultMode:  { type: String, default: "split" },
});
const emit = defineEmits(["update:modelValue"]);

const textareaEl = ref(null);
const mode = ref(["edit", "split", "preview"].includes(props.defaultMode) ? props.defaultMode : "split");

const modeOptions = [
  { value: "edit",    label: "Edit",    icon: "edit" },
  { value: "split",   label: "Split",   icon: "view_column" },
  { value: "preview", label: "Preview", icon: "preview" },
];

// Configure `marked` once. We turn off the gfm extras we don't want
// (auto-detected URLs that turn into <a href> are fine; <h1 id> anchors
// add noise to small system-prompt previews so we keep IDs off).
marked.setOptions({
  gfm: true,
  breaks: false,           // hard breaks need an explicit blank line — same as GitHub's default
  headerIds: false,
  mangle: false,
});

const renderedHtml = computed(() => {
  try { return marked.parse(props.modelValue || ""); }
  catch (e) { return `<pre class="md-render-error">${escapeHtml(e.message || "render failed")}</pre>`; }
});

function onInput(e) {
  emit("update:modelValue", e.target.value);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
</script>

<style scoped>
.md-editor {
  border: 1px solid var(--border, #d0d4dc);
  border-radius: 4px;
  background: var(--surface, #fff);
  overflow: hidden;
}
.md-toolbar {
  background: var(--surface-2, #fafbfd);
  border-bottom: 1px solid var(--border, #d0d4dc);
}
.md-label {
  font-size: 12px;
  color: var(--text-muted, #6b7280);
  letter-spacing: 0.02em;
}
.md-mode-toggle :deep(.q-btn) {
  font-size: 11px;
  padding: 2px 8px;
}

.md-body {
  position: relative;
}
.md-half {
  width: 50%;
  flex: 0 0 50%;
}
.md-half.md-textarea {
  border-right: 1px solid var(--border, #d0d4dc);
}

/* Edit pane */
.md-textarea {
  border: none;
  outline: none;
  resize: none;
  padding: 10px 12px;
  background: var(--surface, #fff);
  color: var(--text, #1f2937);
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 13px;
  line-height: 1.5;
  width: 100%;
}
.md-textarea:focus {
  background: var(--surface, #fff);
}

/* Preview pane */
.md-preview {
  padding: 10px 14px;
  overflow-y: auto;
  background: var(--surface, #fff);
}
.md-empty {
  color: var(--text-muted, #6b7280);
  font-size: 13px;
  font-style: italic;
}

/* Foot — mirrors q-input hint/error styling */
.md-foot {
  border-top: 1px solid var(--border, #d0d4dc);
  background: var(--surface-2, #fafbfd);
  font-size: 11px;
  min-height: 22px;
}
.md-hint  { color: var(--text-muted, #6b7280); }
.md-error { color: var(--danger, #dc2626); }

/* Markdown rendering — keep it compact, code blocks readable. */
.md-rendered :deep(h1),
.md-rendered :deep(h2),
.md-rendered :deep(h3),
.md-rendered :deep(h4) {
  margin: 14px 0 6px;
  line-height: 1.3;
  color: var(--text, #1f2937);
}
.md-rendered :deep(h1) { font-size: 1.4em; }
.md-rendered :deep(h2) { font-size: 1.25em; }
.md-rendered :deep(h3) { font-size: 1.1em; }
.md-rendered :deep(h4) { font-size: 1em; font-weight: 600; }
.md-rendered :deep(p)  { margin: 6px 0; line-height: 1.5; }
.md-rendered :deep(ul),
.md-rendered :deep(ol) { padding-left: 22px; margin: 6px 0; }
.md-rendered :deep(li) { margin: 2px 0; }
.md-rendered :deep(blockquote) {
  border-left: 3px solid var(--border, #d0d4dc);
  margin: 8px 0;
  padding: 2px 12px;
  color: var(--text-muted, #6b7280);
}
.md-rendered :deep(code) {
  background: rgba(0,0,0,0.06);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 12px;
  font-family: ui-monospace, Menlo, Consolas, monospace;
}
.md-rendered :deep(pre) {
  background: rgba(0,0,0,0.06);
  padding: 10px 12px;
  border-radius: 4px;
  overflow-x: auto;
  margin: 8px 0;
  font-size: 12.5px;
  line-height: 1.45;
}
.md-rendered :deep(pre code) {
  background: transparent;
  padding: 0;
  font-size: inherit;
}
.md-rendered :deep(table) {
  border-collapse: collapse;
  margin: 8px 0;
}
.md-rendered :deep(th),
.md-rendered :deep(td) {
  border: 1px solid var(--border, #d0d4dc);
  padding: 4px 8px;
  font-size: 12.5px;
}
.md-rendered :deep(a) {
  color: var(--primary, #2f6df3);
}
.md-rendered :deep(hr) {
  border: none;
  border-top: 1px solid var(--border, #d0d4dc);
  margin: 14px 0;
}
.md-render-error {
  background: var(--danger-soft, #fde6e6);
  color: var(--danger, #dc2626);
  padding: 8px 10px;
  border-radius: 4px;
  font-size: 12px;
}
</style>
