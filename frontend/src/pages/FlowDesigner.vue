<template>
    <q-layout view="hHh lpR fFf">
        <q-header class="bg-grey-12">
            <q-toolbar dense>
                <q-btn flat round dense icon="arrow_back" @click="goBack" class="text-black">
                    <q-tooltip>Back</q-tooltip>
                </q-btn>
                <q-toolbar-title class="text-black">
                    <b>{{ isNew ? "New flow" : model.name }}</b>
                    <span v-if="serverVersion" class="q-ml-sm text-caption text-grey-7">v{{ serverVersion }}</span>
                    <span v-if="dirty" class="q-ml-xs text-caption text-orange">●</span>
                </q-toolbar-title>
                <q-space />

                <q-btn flat dense no-caps icon="upload" label="Import" class="text-black q-mr-xs" @click="onImport" />
                <q-btn flat dense no-caps icon="download" label="Export" class="text-black q-mr-xs" @click="onExport" />
                <q-btn flat dense no-caps icon="play_arrow" label="Run" class="text-black q-mr-sm" disable>
                    <q-tooltip>Coming soon</q-tooltip>
                </q-btn>
                <q-btn unelevated dense no-caps color="primary" icon="save" label="Save" :loading="saving"
                    @click="onSave" />
            </q-toolbar>

            <q-tabs v-model="tab" dense align="left" no-caps active-color="primary" indicator-color="primary"
                class="text-black">
                <q-tab name="prompt" label="Prompt" />
                <q-tab name="overview"   label="Overview" />
                <q-tab name="canvas"   label="Flow editor" />
                <q-tab name="yaml"   label="YAML" />
            </q-tabs>
        </q-header>

        <q-page-container>
            <q-page>
                <q-banner v-if="loadError" dense class="bg-red-10 text-red-2">
                    <template v-slot:avatar><q-icon name="error_outline" /></template>
                    {{ loadError }}
                </q-banner>

                <div v-if="loading" class="row flex-center q-pa-lg">
                    <q-spinner-dots color="primary" size="32px" />
                </div>

                <q-tab-panels v-else v-model="tab" animated keep-alive class="full-tabs">
                    <q-tab-panel name="prompt" class="q-pa-none">
                        <PromptTab v-model="model" />
                    </q-tab-panel>
                    <q-tab-panel name="overview" class="q-pa-none">
                        <OverviewTab v-model="model" />
                    </q-tab-panel>
                    <q-tab-panel name="canvas" class="q-pa-none">
                        <CanvasTab v-model="model" :plugins="plugins" />
                    </q-tab-panel>
                    <q-tab-panel name="yaml" class="q-pa-none">
                        <YamlTab v-model="model" />
                    </q-tab-panel>
                </q-tab-panels>
            </q-page>
        </q-page-container>
    </q-layout>
</template>

<script setup>
import { ref, computed, onMounted, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useQuasar } from "quasar";
import { Graphs, Plugins } from "../api/client";

import PromptTab from "../components/flow/PromptTab.vue";
import OverviewTab from "../components/flow/OverviewTab.vue";
import CanvasTab from "../components/flow/CanvasTab.vue";
import YamlTab from "../components/flow/YamlTab.vue";
import {
    emptyModel,
    parseYamlToModel,
    serializeModelToYaml,
    pickFileAsText,
    downloadText,
} from "../components/flow/flowModel.js";

const route = useRoute();
const router = useRouter();
const $q = useQuasar();

const isNew = computed(() => route.params.id === "new" || !route.params.id);

const tab = ref("overview");          // start on Overview when editing existing flow
const loading = ref(true);
const saving = ref(false);
const loadError = ref("");
const dirty = ref(false);

const model = ref(emptyModel());
const plugins = ref([]);
// The server-tracked auto-incremented version — surfaced read-only in the
// header so the user can see which revision they're editing. Not part of
// the model / YAML.
const serverVersion = ref(null);

let lastSavedYaml = "";

onMounted(async () => {
    // Plugins (for the canvas palette + property panel autocomplete).
    Plugins.list().then(list => { plugins.value = list || []; }).catch(() => { });

    if (isNew.value) {
        tab.value = "prompt";              // new flows start on the AI prompt tab
        lastSavedYaml = serializeModelToYaml(model.value);
        loading.value = false;
        return;
    }
    try {
        const g = await Graphs.get(route.params.id);
        model.value = parseYamlToModel(g.yaml);
        lastSavedYaml = g.yaml;
        serverVersion.value = g.version ?? null;
    } catch (e) {
        loadError.value = errMsg(e);
    } finally {
        loading.value = false;
    }
});

// Track whether the model has diverged from the last saved version.
watch(model, (m) => {
    try { dirty.value = serializeModelToYaml(m) !== lastSavedYaml; }
    catch { dirty.value = true; }
}, { deep: true });

// ----- toolbar -----
async function onSave() {
    saving.value = true;
    try {
        const yaml = serializeModelToYaml(model.value);
        // Validate first — surfaces parser errors early.
        try { await Graphs.validate(yaml); }
        catch (e) { throw new Error(formatValidationErr(e)); }

        let saved;
        if (isNew.value) saved = await Graphs.create(yaml);
        else saved = await Graphs.update(route.params.id, yaml);

        lastSavedYaml = yaml;
        dirty.value = false;
        serverVersion.value = saved.version ?? null;
        $q.notify({ type: "positive", message: `Saved "${saved.name}" v${saved.version}`, position: "bottom" });
        router.replace({ path: `/flowDesigner/${saved.id}` });
    } catch (e) {
        $q.notify({ type: "negative", message: `Save failed: ${e.message}`, position: "bottom" });
    } finally {
        saving.value = false;
    }
}

async function onImport() {
    const text = await pickFileAsText(".yaml,.yml,.txt");
    if (!text) return;
    try {
        model.value = parseYamlToModel(text);
        $q.notify({ type: "positive", message: "Imported", timeout: 1500, position: "bottom" });
    } catch (e) {
        $q.notify({ type: "negative", message: `Import failed: ${e.message}`, position: "bottom" });
    }
}

function onExport() {
    const yaml = serializeModelToYaml(model.value);
    const safeName = (model.value.name || "flow").replace(/[^A-Za-z0-9_.-]/g, "_");
    downloadText(`${safeName}.yaml`, yaml);
}

function goBack() {
    if (dirty.value) {
        $q.dialog({
            title: "Unsaved changes",
            message: "Discard changes and leave?",
            ok: { label: "Discard", color: "negative", unelevated: true, "no-caps": true },
            cancel: { label: "Stay", flat: true, "no-caps": true },
            persistent: true,
        }).onOk(_actuallyGoBack);
    } else {
        _actuallyGoBack();
    }
}
function _actuallyGoBack() {
    if (window.history.length > 1) router.back();
    else router.push("/");
}

// Warn on page reload / browser-close when there are unsaved changes.
window.addEventListener("beforeunload", (e) => {
    if (dirty.value) { e.preventDefault(); e.returnValue = ""; }
});

function errMsg(e) { return e?.response?.data?.message || e?.message || "unknown error"; }
function formatValidationErr(e) {
    const data = e?.response?.data;
    if (!data) return e?.message || "validation failed";
    const details = (data.details || []).map(d => ` • ${d.path || ""} ${d.message || ""}`).join("\n");
    return `${data.message}${details ? "\n" + details : ""}`;
}
</script>

<style scoped>
.full-tabs {
    height: calc(100vh - 96px);
}

.full-tabs :deep(.q-tab-panel) {
    height: 100%;
    padding: 0;
}
</style>
