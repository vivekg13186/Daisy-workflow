<script setup>
import { ref, computed, watch } from "vue";
import YamlEditor from "./YamlEditor.vue";
import GraphView from "./GraphView.vue";
import RunDialog from "./RunDialog.vue";
import ExecutionView from "./ExecutionView.vue";
import { useGraphsStore } from "../stores/graphs.js";

const store = useGraphsStore();
const editorView = ref("yaml");          // "yaml" | "graph"
const runDialogOpen = ref(false);
const runLink = ref(null);                // { execId } shown briefly after launch

const tab = computed(() => store.activeTab);
const isEditor = computed(() => tab.value?.kind === "graph");
const isExec = computed(() => tab.value?.kind === "execution");

const initialInput = computed(() => store.activeGraphTab?.parsed?.data || {});

async function onValidate() { await store.validate(); }
async function onSave() { await store.save(); }

async function onRun() {
  if (!isEditor.value) return;
  if (!store.activeGraphTab?.parsed) await store.validate();
  if (store.activeGraphTab?.validationError) return;
  runDialogOpen.value = true;
}

async function onRunSubmit(input) {
  runDialogOpen.value = false;
  const execId = await store.run(input);
  if (execId) runLink.value = { execId };
}

function openResult() {
  if (runLink.value) {
    store.openExecution(runLink.value.execId, store.activeGraphTab?.graphId, /*live=*/false);
    runLink.value = null;
  }
}

watch(() => store.activeId, () => { runLink.value = null; });

function tabLabel(t) {
  if (t.kind === "graph") return `${t.name}${t.dirty ? " ●" : ""}`;
  return `▶ ${t.execId.slice(0, 6)}`;
}
function tabIcon(t) {
  return t.kind === "graph" ? "edit" : "play_arrow";
}

function onCloseTab() {
  if (store.activeId) store.closeTab(store.activeId);
}
</script>

<template>
  <div class="workspace column no-wrap full-height">
    <!--
    <q-toolbar>

      <q-select v-if="store.tabs.length" v-model="store.activeId"
        :options="store.tabs.map(t => ({ label: tabLabel(t), value: t.id, icon: tabIcon(t) }))" emit-value map-options
        borderless options-dense dense style="min-width: 180px;width: 100%;">

        <template v-slot:option="scope">
          <q-item v-bind="scope.itemProps" dense>
            <q-item-section>{{ scope.opt.label }}</q-item-section>
          </q-item>
        </template>
      </q-select>

      <q-space />
      <q-btn round outline color="primary" size="sm" no-caps icon="close" :disable="!store.activeId"
        @click="onCloseTab">
        <q-tooltip>Close tab</q-tooltip>
      </q-btn>

    </q-toolbar>
        -->

    <!-- Editor toolbar (only for editor tabs) -->
    <q-toolbar v-if="isEditor" dense class="q-py-xs bg-grey-11" style="min-height: 36px;">


      <q-btn-toggle v-model="editorView" rounded outline no-caps size="sm" toggle-color="primary" :options="[
        { label: 'YAML', value: 'yaml', icon: 'code' },
        { label: 'Graph', value: 'graph', icon: 'schema' },
      ]" />

      <q-space />


      <div class="q-gutter-xs q-pl-xs">

        <q-btn round outline color="primary" size="sm" no-caps icon="check_circle" @click="onValidate">
          <q-tooltip>Validate</q-tooltip>
        </q-btn>
        <q-btn round outline color="primary" size="sm" no-caps icon="save" @click="onSave">
          <q-tooltip>Save</q-tooltip>
        </q-btn>
        <q-btn round outline color="green-12" size="sm" no-caps icon="play_arrow"
          :disable="!store.activeGraphTab.parsed && !store.activeGraphTab.graphId" @click="onRun">
          <q-tooltip>Run</q-tooltip>
        </q-btn>
      </div>
    </q-toolbar>

    <!-- Empty state -->
    <div v-if="!tab" class="col flex flex-center text-grey">
      <div class="text-center">
        <q-icon name="layers" size="48px" class="q-mb-sm" />
        <div>Open a flow on the left, or create a new one.</div>
      </div>
    </div>

    <!-- Editor body -->
    <template v-else-if="isEditor">
      <div v-show="editorView === 'yaml'" class="col" style="min-height: 0;">
        <YamlEditor />
      </div>
      <div v-show="editorView === 'graph'" class="col" style="min-height: 0;">
        <GraphView mode="edit" />
      </div>
      <q-banner v-if="store.activeGraphTab?.validationError" dense class="bg-red-10 text-red-2"
        style="white-space: pre-wrap;">
        <template v-slot:avatar><q-icon name="error_outline" /></template>
        {{ store.activeGraphTab.validationError }}
      </q-banner>

      <!-- Floating "open result" toast -->
      <q-banner v-if="runLink" dense rounded class="bg-grey-10 text-white"
        style="position: absolute; bottom: 16px; right: 16px; z-index: 10;">
        Execution launched.
        <template v-slot:action>
          <q-btn dense flat color="primary" no-caps label="Open result →" @click="openResult" />
          <q-btn dense flat icon="close" @click="runLink = null" />
        </template>
      </q-banner>
    </template>

    <!-- Execution viewer body -->
    <ExecutionView v-else-if="isExec" />

    <RunDialog v-model="runDialogOpen" :initial="initialInput" @submit="onRunSubmit" />
  </div>
</template>
