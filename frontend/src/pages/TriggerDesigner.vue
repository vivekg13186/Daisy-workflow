<template>
  <q-layout view="hHh lpR fFf">
    <q-header class="app-header">
      <q-toolbar class="app-toolbar">
        <q-btn flat round dense icon="arrow_back" class="btn-toolbar q-mr-sm" @click="goBack">
          <q-tooltip>Back</q-tooltip>
        </q-btn>
        <q-toolbar-title>
          {{ isNew ? "New trigger" : (form.name || "Trigger") }}
          <span v-if="!isNew && form.type" class="app-subtitle">{{ form.type }}</span>
        </q-toolbar-title>
        <q-space />
        <q-btn
          unelevated 
          color="primary"
          icon="save"
          class="btn-icon-primary"
          :loading="saving"
          :disable="!configParsed.ok"
          @click="onSave"
        >
          <q-tooltip>Save</q-tooltip>
        </q-btn>
      </q-toolbar>
    </q-header>

    <q-page-container>
      <q-page class="app-page">
        <div v-if="loading" class="row flex-center q-pa-lg">
          <q-spinner-dots color="primary" size="32px" />
        </div>

        <div v-else class="column q-gutter-md q-pl-md" style="max-width: 720px;">
          <q-input  class="q-pl-sm" v-model="form.name" dense outlined label="Name" autofocus   />

          <q-select class="q-pl-sm"
            v-model="form.graphId"
            dense outlined label="Flow"
            :options="graphOptions"
            emit-value map-options
            :disable="!isNew"
            :hint="!isNew ? 'Flow cannot be changed once a trigger is saved.' : ''"
          />

          <q-select class="q-pl-sm"
            v-model="form.type"
            dense outlined label="Type"
            :options="typeOptions"
            emit-value map-options
            :disable="!isNew"
            :hint="!isNew ? 'Type cannot be changed once a trigger is saved.' : currentHint"
          />

          <!-- Optional per-type editor swap-in. Falls back to a JSON editor. -->
          <!-- triggerId is passed so editors that need it (e.g. webhook) can
               show a live endpoint URL. Editors that don't care simply ignore it. -->
          <component
            v-if="typeEditor"
            :is="typeEditor"
            v-model="configForm"
            :trigger-id="isNew ? null : route.params.id"
          />
          <div v-else>
            <div class="text-caption text-grey q-mb-xs q-pl-sm">
              Config (JSON) — {{ currentHint }}
            </div>
            <q-input class="q-pl-sm"
              v-model="configText"
              type="textarea"
              dense outlined autogrow
              input-style="font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12.5px; min-height: 220px;"
              :error="!configParsed.ok"
              :error-message="configParsed.ok ? '' : configParsed.error"
            />
          </div>

          <q-toggle v-model="form.enabled" class="q-pl-md" label="Enabled (subscribe immediately)" dense />

          <q-banner v-if="error" dense class="bg-red-10 text-red-2"
                    style="white-space: pre-wrap;">
            <template v-slot:avatar><q-icon name="error_outline" /></template>
            {{ error }}
          </q-banner>
        </div>
      </q-page>
    </q-page-container>
  </q-layout>
</template>

<script setup>
import { ref, computed, watch, onMounted, shallowRef, defineAsyncComponent, markRaw } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useQuasar } from "quasar";
import { Graphs, Triggers } from "../api/client";

const route = useRoute();
const router = useRouter();
const $q = useQuasar();

const isNew = computed(() => route.params.id === "new" || !route.params.id);

// Per-type starter snippets and hints (mirror of TriggerDialog).
const TYPE_TEMPLATES = {
  schedule: {
    label: "Schedule (cron / interval)",
    config: { cron: "0 */5 * * * *" },
    hint: "Use `cron` (croner format) OR `intervalMs`. Optional `timezone`.",
  },
  mqtt: {
    label: "MQTT (subscribe to topic)",
    // Broker URL / credentials live on a stored `mqtt` configuration row
    // (Home → Configurations). The trigger references it by name via the
    // `config` field below — never the URL directly.
    config: { config: "", topic: "sensors/+/temp", qos: 0, parseJson: true },
    hint: "Set `config` to the name of a stored mqtt configuration. `topic` may be a string or array.",
  },
  email: {
    label: "Email (IMAP inbox)",
    config: {
      host: "imap.example.com", port: 993, secure: true,
      user: "you@example.com", pass: "...",
      mailbox: "INBOX", markAsSeen: true, pollIntervalMs: 60000,
    },
    hint: "Watches an IMAP mailbox; uses IDLE if supported.",
  },
  webhook: {
    label: "Webhook (HTTP endpoint)",
    config: { methods: ["POST"] },
    hint: "Fires when an HTTP request hits /webhooks/<id>. Optional secret + method whitelist.",
  },
};

// Optional drop-in per-type editor components. If a file exists at
// ../components/<X>Trigger.vue, it's used instead of the JSON editor.
//
// Vite's import.meta.glob (lazy mode) returns `() => Promise<Module>` thunks.
// We can't bind those directly to <component :is> — Vue would render the raw
// Promise as `[object Promise]`. Wrap each loader in defineAsyncComponent so
// Vue knows to await the import and use the resolved default export.
// markRaw stops Vue from making the component definition reactive (which
// would otherwise emit a noisy "Vue received a Component which was made a
// reactive object" warning).
const TYPE_EDITORS_GLOB = import.meta.glob("../components/*Trigger.vue");
const _editorCache = new Map();

function resolveEditor(type) {
  const map = {
    schedule: "ScheduleTrigger",
    mqtt:     "MqTrigger",
    email:    "MailTrigger",
    webhook:  "WebhookTrigger",
  };
  const name = map[type];
  if (!name) return null;
  const key = `../components/${name}.vue`;
  const loader = TYPE_EDITORS_GLOB[key];
  if (!loader) return null;
  if (_editorCache.has(key)) return _editorCache.get(key);
  const comp = markRaw(defineAsyncComponent(loader));
  _editorCache.set(key, comp);
  return comp;
}

// ----- form state -----
const loading = ref(true);
const saving  = ref(false);
const error   = ref("");

const form = ref({
  name: "",
  graphId: "",
  type: "schedule",
  enabled: true,
});
const configText = ref(JSON.stringify(TYPE_TEMPLATES.schedule.config, null, 2));
const configForm = ref({ ...TYPE_TEMPLATES.schedule.config });   // for per-type editors
const graphs = ref([]);
const typeEditor = shallowRef(null);

const graphOptions = computed(() =>
  graphs.value.map(g => ({ label: `${g.name}`, value: g.id })));
const typeOptions = computed(() =>
  Object.entries(TYPE_TEMPLATES).map(([v, t]) => ({ label: t.label, value: v })));
const currentHint = computed(() => TYPE_TEMPLATES[form.value.type]?.hint || "");

const configParsed = computed(() => {
  try { return { ok: true, value: JSON.parse(configText.value || "{}") }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// ----- lifecycle -----
onMounted(async () => {
  graphs.value = await Graphs.list().catch(() => []);

  if (isNew.value) {
    form.value.graphId = graphs.value[0]?.id || "";
    typeEditor.value = resolveEditor(form.value.type);
  } else {
    try {
      const t = await Triggers.get(route.params.id);
      form.value.name    = t.name || "";
      form.value.graphId = t.graph_id;
      form.value.type    = t.type;
      form.value.enabled = !!t.enabled;
      configForm.value   = t.config || {};
      configText.value   = JSON.stringify(t.config || {}, null, 2);
      typeEditor.value   = resolveEditor(t.type);
    } catch (e) {
      error.value = `Load failed: ${errMsg(e)}`;
    }
  }
  loading.value = false;
});

// When the user picks a type for a NEW trigger, swap in the matching template.
watch(() => form.value.type, (newType) => {
  typeEditor.value = resolveEditor(newType);
  if (!isNew.value) return;
  const tpl = TYPE_TEMPLATES[newType];
  if (tpl) {
    configText.value = JSON.stringify(tpl.config, null, 2);
    configForm.value = { ...tpl.config };
  }
});

// Keep configForm <-> configText loosely in sync. The per-type editor edits
// configForm; the JSON textarea edits configText. We marshal between them
// when saving.

async function onSave() {
  error.value = "";
  if (!form.value.name.trim()) { error.value = "name is required"; return; }
  if (!form.value.graphId)      { error.value = "select a flow"; return; }

  // Determine effective config: prefer the per-type editor's value if used.
  const config = typeEditor.value ? configForm.value : configParsed.value.value;
  if (!typeEditor.value && !configParsed.value.ok) {
    error.value = `config: ${configParsed.value.error}`;
    return;
  }

  saving.value = true;
  try {
    if (isNew.value) {
      const created = await Triggers.create({
        name:    form.value.name.trim(),
        graphId: form.value.graphId,
        type:    form.value.type,
        config,
        enabled: form.value.enabled,
      });
      $q.notify({ type: "positive", message: "Trigger created", position: "bottom" });
      router.replace({ path: `/triggerDesigner/${created.id}` });
    } else {
      await Triggers.update(route.params.id, {
        name:    form.value.name.trim(),
        config,
        enabled: form.value.enabled,
      });
      $q.notify({ type: "positive", message: "Trigger updated", position: "bottom" });
    }
  } catch (e) {
    error.value = errMsg(e);
  } finally {
    saving.value = false;
  }
}

function goBack() {
  if (window.history.length > 1) router.back();
  else router.push("/");
}
function errMsg(e) { return e?.response?.data?.message || e?.message || "unknown error"; }
</script>
