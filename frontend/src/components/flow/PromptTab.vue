<!--
  Prompt → AI generate workflow.
  - Markdown textarea where the user describes what they want.
  - Calls /ai/chat (system prompt already includes the live plugin list + DSL ref).
  - Extracts the first ```yaml code block from the response and replaces the
    parent flow model. The prompt itself is stored on model.meta.prompt.
-->
<template>
  <div class="column q-gutter-md q-pa-md">
    <div class="text-caption text-grey">
      Describe the workflow you want and the AI will generate one. Markdown is fine.
      The prompt is saved with the workflow under <code>meta.prompt</code>.
    </div>

    <q-input
      v-model="promptText"
      type="textarea"
      dense filled autogrow
      label="Prompt (markdown)"
      input-style="font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 13px; min-height: 220px;"
      :disable="generating"
    />

    <div class="row items-center q-gutter-sm">
      <q-btn
        unelevated dense no-caps
        color="primary" icon="auto_awesome" label="Generate"
        :loading="generating"
        :disable="!promptText.trim()"
        @click="onGenerate"
      />
      <q-btn dense flat no-caps icon="restart_alt" label="Clear" @click="promptText = ''" />
      <q-space />
      <span v-if="lastStatus" class="text-caption" :class="lastStatus.ok ? 'text-positive' : 'text-negative'">
        {{ lastStatus.message }}
      </span>
    </div>

    <q-banner v-if="error" dense class="bg-red-10 text-red-2"
              style="white-space: pre-wrap;">
      <template v-slot:avatar><q-icon name="error_outline" /></template>
      {{ error }}
    </q-banner>

    <q-card v-if="rawResponse" flat bordered>
      <q-card-section class="q-pa-sm">
        <div class="row items-center">
          <div class="text-caption text-grey">AI response (raw)</div>
          <q-space />
          <q-btn dense flat no-caps size="xs" icon="content_copy" @click="copy(rawResponse)" />
        </div>
        <pre class="ai-pre">{{ rawResponse }}</pre>
      </q-card-section>
    </q-card>
  </div>
</template>

<script setup>
import { ref, computed, watch } from "vue";
import { useQuasar } from "quasar";
import { AI } from "../../api/client";
import { parseYamlToModel } from "./flowModel.js";

const props = defineProps({
  modelValue: { type: Object, required: true },          // the flow model
});
const emit = defineEmits(["update:modelValue"]);

const $q = useQuasar();
const generating = ref(false);
const error = ref("");
const rawResponse = ref("");
const lastStatus = ref(null);

const promptText = computed({
  get: () => props.modelValue?.meta?.prompt || "",
  set: (v) => {
    const next = { ...props.modelValue };
    next.meta = { ...(next.meta || {}), prompt: v };
    emit("update:modelValue", next);
  },
});

async function onGenerate() {
  error.value = "";
  rawResponse.value = "";
  lastStatus.value = null;
  generating.value = true;
  try {
    const { message } = await AI.chat([
      { role: "user", content: promptText.value.trim() + "\n\nRespond with the complete workflow YAML in a ```yaml code block." },
    ]);
    rawResponse.value = message?.content || "";

    const yamlBlock = extractYaml(rawResponse.value);
    if (!yamlBlock) {
      error.value = "No ```yaml block found in the AI response.";
      return;
    }

    const newModel = parseYamlToModel(yamlBlock);
    // Preserve the user's prompt under meta.
    newModel.meta = { ...(newModel.meta || {}), prompt: promptText.value };
    emit("update:modelValue", newModel);
    lastStatus.value = { ok: true, message: `Generated "${newModel.name}" with ${newModel.nodes.length} node(s).` };
  } catch (e) {
    error.value = e?.response?.data?.message || e.message || "Generation failed";
  } finally {
    generating.value = false;
  }
}

function extractYaml(text) {
  const m = /```(?:yaml|yml)?\s*\n([\s\S]*?)```/i.exec(text);
  return m ? m[1] : null;
}

function copy(text) {
  navigator.clipboard.writeText(text).then(
    () => $q.notify({ type: "positive", message: "Copied", timeout: 1200, position: "bottom" }),
  );
}

// If the parent loads a saved flow with an existing prompt, surface it.
watch(() => props.modelValue, (m) => {
  if (m?.meta?.prompt && !promptText.value) {
    // computed setter writes back, so just reading triggers nothing.
  }
}, { immediate: true });
</script>

<style scoped>
.ai-pre {
  margin: 6px 0 0;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 11.5px;
  white-space: pre-wrap;
  word-break: break-word;
  background: rgba(0,0,0,0.25);
  padding: 8px 10px;
  border-radius: 4px;
  max-height: 320px;
  overflow: auto;
}
code {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 12px;
  background: rgba(0,0,0,0.25);
  padding: 1px 5px;
  border-radius: 3px;
}
</style>
