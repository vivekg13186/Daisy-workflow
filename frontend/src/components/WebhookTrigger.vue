<!--
  Form editor for the `webhook` trigger config. Used by TriggerDesigner via
  `<component :is="typeEditor" v-model="configForm" :trigger-id="..." />`.

  Config shape (matches backend/src/triggers/builtin/webhook.js):
    methods: ["POST"]   array of allowed methods (or ["ANY"]); default ["POST"]
    secret:  string     optional; if set, callers must send the same value as
                        X-Webhook-Secret header (or ?secret=... query).
-->
<template>
  <div class="column q-gutter-sm">
    <q-select
      :model-value="cfg.methods || ['POST']"
      @update:model-value="set('methods', $event)"
      dense filled
      multiple
      use-chips
      label="Allowed methods"
      :options="methodOptions"
      hint="Pick one or more HTTP methods, or ANY to accept everything."
    />

    <q-input
      :model-value="cfg.secret || ''"
      @update:model-value="setSecret"
      dense filled
      label="Shared secret"
      :type="showSecret ? 'text' : 'password'"
      autocomplete="new-password"
      hint="Optional. When set, callers must send X-Webhook-Secret matching this value (or ?secret=… as a query param)."
    >
      <template v-slot:append>
        <q-icon
          :name="showSecret ? 'visibility_off' : 'visibility'"
          class="cursor-pointer"
          @click="showSecret = !showSecret"
        />
        <q-btn flat round dense icon="autorenew" size="sm" @click="generateSecret">
          <q-tooltip>Generate a random 32-char secret</q-tooltip>
        </q-btn>
      </template>
    </q-input>

    <!-- URL display + curl helper. Only meaningful once the trigger has an id. -->
    <q-card v-if="triggerId" flat bordered class="q-mt-sm">
      <q-card-section class="q-pa-sm">
        <div class="text-caption text-grey">Endpoint URL</div>
        <div class="row items-center q-mt-xs">
          <code class="ellipsis col">{{ webhookUrl }}</code>
          <q-btn dense flat icon="content_copy" size="sm" @click="copyUrl">
            <q-tooltip>Copy URL</q-tooltip>
          </q-btn>
        </div>
      </q-card-section>

      <q-separator />

      <q-card-section class="q-pa-sm">
        <div class="text-caption text-grey q-mb-xs">curl example</div>
        <pre class="curl-pre">{{ curlExample }}</pre>
        <div class="row q-mt-xs">
          <q-space />
          <q-btn dense flat icon="content_copy" size="sm" no-caps label="Copy"
                 @click="copyCurl" />
          <q-btn
            dense unelevated no-caps size="sm" color="primary" icon="play_arrow" label="Test fire"
            class="q-ml-sm"
            :loading="testing"
            @click="testFire"
          />
        </div>
        <div v-if="testResult" class="text-caption q-mt-xs"
             :class="testResult.ok ? 'text-positive' : 'text-negative'">
          {{ testResult.message }}
        </div>
      </q-card-section>
    </q-card>

    <q-banner v-else dense rounded class="bg-grey-10 text-grey-3">
      <template v-slot:avatar><q-icon name="info" /></template>
      <div class="text-caption">
        Save the trigger to get its endpoint URL. The URL will be
        <code>{{ origin }}/webhooks/&lt;trigger-id&gt;</code>.
      </div>
    </q-banner>
  </div>
</template>

<script setup>
import { computed, ref } from "vue";
import { useQuasar } from "quasar";

const props = defineProps({
  modelValue: { type: Object, default: () => ({}) },
  // Optional — once known, used to render the live URL + curl helper.
  triggerId: { type: String, default: null },
});
const emit = defineEmits(["update:modelValue"]);

const $q = useQuasar();
const showSecret = ref(false);
const testing = ref(false);
const testResult = ref(null);

const methodOptions = ["GET", "POST", "PUT", "PATCH", "DELETE", "ANY"];

const cfg = computed(() => props.modelValue || {});
const origin = computed(() => (typeof window !== "undefined" ? window.location.origin : ""));

const webhookUrl = computed(() => {
  if (!props.triggerId) return "";
  return `${origin.value}/webhooks/${props.triggerId}`;
});

const curlExample = computed(() => {
  if (!webhookUrl.value) return "";
  const method = (cfg.value.methods || ["POST"])[0] || "POST";
  const lines = [`curl -X ${method.toUpperCase() === "ANY" ? "POST" : method.toUpperCase()} \\`];
  if (cfg.value.secret) lines.push(`  -H "x-webhook-secret: ${cfg.value.secret}" \\`);
  if (method === "POST" || method === "PUT" || method === "PATCH" || method === "ANY") {
    lines.push(`  -H "content-type: application/json" \\`);
    lines.push(`  -d '{"hello":"world"}' \\`);
  }
  lines.push(`  ${webhookUrl.value}`);
  return lines.join("\n");
});

function emitNext(patch) {
  emit("update:modelValue", { ...cfg.value, ...patch });
}
function set(key, value) {
  emitNext({ [key]: value });
}
function setSecret(value) {
  if (!value) {
    const next = { ...cfg.value };
    delete next.secret;
    emit("update:modelValue", next);
    return;
  }
  emitNext({ secret: value });
}

function generateSecret() {
  const arr = new Uint8Array(24);
  (window.crypto || window.msCrypto).getRandomValues(arr);
  const hex = Array.from(arr).map(b => b.toString(16).padStart(2, "0")).join("");
  emitNext({ secret: hex });
}

function copyUrl() {
  navigator.clipboard.writeText(webhookUrl.value).then(
    () => $q.notify({ type: "positive", message: "URL copied", timeout: 1200, position: "bottom" }),
    () => $q.notify({ type: "negative", message: "Copy failed", timeout: 1500, position: "bottom" }),
  );
}
function copyCurl() {
  navigator.clipboard.writeText(curlExample.value).then(
    () => $q.notify({ type: "positive", message: "Copied", timeout: 1200, position: "bottom" }),
    () => $q.notify({ type: "negative", message: "Copy failed", timeout: 1500, position: "bottom" }),
  );
}

async function testFire() {
  if (!props.triggerId) return;
  testing.value = true;
  testResult.value = null;
  const method = (cfg.value.methods || ["POST"])[0] || "POST";
  const verb = method === "ANY" ? "POST" : method.toUpperCase();
  const headers = { "content-type": "application/json" };
  if (cfg.value.secret) headers["x-webhook-secret"] = cfg.value.secret;
  try {
    const res = await fetch(webhookUrl.value, {
      method: verb,
      headers,
      body: ["GET", "DELETE"].includes(verb) ? undefined : JSON.stringify({ test: true, at: new Date().toISOString() }),
    });
    const data = await res.json().catch(() => ({}));
    testResult.value = res.ok
      ? { ok: true, message: `Fired — execution ${data.executionId?.slice(0, 8) || "queued"}` }
      : { ok: false, message: `${res.status}: ${data.message || res.statusText}` };
  } catch (e) {
    testResult.value = { ok: false, message: e.message };
  } finally {
    testing.value = false;
  }
}
</script>

<style scoped>
.curl-pre {
  margin: 0;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 11.5px;
  white-space: pre-wrap;
  word-break: break-word;
  background: rgba(0,0,0,0.25);
  padding: 6px 8px;
  border-radius: 4px;
}
code {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 12px;
  background: rgba(0,0,0,0.25);
  padding: 1px 6px;
  border-radius: 3px;
}
</style>
