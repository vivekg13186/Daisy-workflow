<!--
  Read-only YAML view of the current flow model. Re-rendered every time the
  model changes — handy for sanity-checking what will be saved.
-->
<template>
  <div class="column full-height">
    <q-toolbar dense class="bg-grey-12">
      <q-icon name="code" class="q-mr-sm" />
      <div class="text-subtitle2">Generated YAML (read-only)</div>
      <q-space />
      <q-btn dense flat no-caps icon="content_copy" label="Copy" @click="copy" />
    </q-toolbar>
    <pre class="yaml-pre col scroll">{{ yaml }}</pre>
  </div>
</template>

<script setup>
import { computed } from "vue";
import { useQuasar } from "quasar";
import { serializeModelToYaml } from "./flowModel.js";

const props = defineProps({
  modelValue: { type: Object, required: true },
});

const $q = useQuasar();

const yaml = computed(() => {
  try { return serializeModelToYaml(props.modelValue); }
  catch (e) { return `# Failed to serialize: ${e.message}`; }
});

function copy() {
  navigator.clipboard.writeText(yaml.value).then(
    () => $q.notify({ type: "positive", message: "Copied", timeout: 1200, position: "bottom" }),
  );
}
</script>

<style scoped>
.yaml-pre {
  margin: 0;
  padding: 12px 14px;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 12.5px;
  white-space: pre;
  overflow: auto;
  background: rgba(0,0,0,0.25);
}
</style>
