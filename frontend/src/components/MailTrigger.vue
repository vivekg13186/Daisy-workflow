<!--
  Form editor for the `email` trigger config (IMAP inbox watcher). Used by
  TriggerDesigner via `<component :is="typeEditor" v-model="configForm" />`.

  Config shape (matches backend/src/triggers/builtin/email.js):
    host:           "imap.example.com"             (required)
    port:           993                             (default 993)
    secure:         true                            (default true; false for STARTTLS on 143)
    user:           "you@example.com"               (required)
    pass:           "..."                           (required)
    mailbox:        "INBOX"                         (default INBOX)
    markAsSeen:     true                            (default true; used for dedup)
    onlyUnseen:     true                            (default true)
    pollIntervalMs: 60000                           (used when server lacks IDLE)
-->
<template>
  <div class="column q-gutter-sm">
    <div class="row q-col-gutter-sm">
      <div class="col-8">
        <q-input
          :model-value="cfg.host || ''"
          @update:model-value="set('host', $event)"
          dense filled
          label="IMAP host *"
          placeholder="imap.gmail.com"
          :error="!cfg.host"
          error-message="Host is required"
        />
      </div>
      <div class="col-4">
        <q-input
          :model-value="cfg.port ?? 993"
          @update:model-value="setNumber('port', $event)"
          dense filled
          type="number"
          label="Port"
          :hint="(cfg.secure !== false) ? 'TLS = 993' : 'STARTTLS = 143'"
        />
      </div>
    </div>

    <q-toggle
      :model-value="cfg.secure !== false"
      @update:model-value="set('secure', $event)"
      dense
      label="Use TLS (turn off for STARTTLS on port 143)"
    />

    <div class="row q-col-gutter-sm">
      <div class="col-6">
        <q-input
          :model-value="cfg.user || ''"
          @update:model-value="set('user', $event)"
          dense filled
          label="Username *"
          placeholder="you@example.com"
          autocomplete="off"
          :error="!cfg.user"
          error-message="Username is required"
        />
      </div>
      <div class="col-6">
        <q-input
          :model-value="cfg.pass || ''"
          @update:model-value="set('pass', $event)"
          dense filled
          label="Password / App password *"
          :type="showPass ? 'text' : 'password'"
          autocomplete="new-password"
          :error="!cfg.pass"
          error-message="Password is required"
          hint="For Gmail/Outlook use an app-password, not your account password."
        >
          <template v-slot:append>
            <q-icon
              :name="showPass ? 'visibility_off' : 'visibility'"
              class="cursor-pointer"
              @click="showPass = !showPass"
            />
          </template>
        </q-input>
      </div>
    </div>

    <q-input
      :model-value="cfg.mailbox || 'INBOX'"
      @update:model-value="set('mailbox', $event)"
      dense filled
      label="Mailbox"
      placeholder="INBOX"
      hint="IMAP folder to watch. Default INBOX."
    />

    <div class="row q-col-gutter-sm items-center">
      <div class="col-6">
        <q-toggle
          :model-value="cfg.markAsSeen !== false"
          @update:model-value="set('markAsSeen', $event)"
          dense
          label="Mark fetched messages as seen"
        />
      </div>
      <div class="col-6">
        <q-toggle
          :model-value="cfg.onlyUnseen !== false"
          @update:model-value="set('onlyUnseen', $event)"
          dense
          label="Only process unseen messages"
        />
      </div>
    </div>

    <q-input
      :model-value="cfg.pollIntervalMs ?? 60000"
      @update:model-value="setNumber('pollIntervalMs', $event)"
      dense filled
      type="number"
      label="Poll interval (ms)"
      hint="Used only when the server doesn't support IMAP IDLE. Min 5000."
      :rules="[v => v >= 5000 || 'Minimum is 5000 ms']"
    />

    <q-banner dense class="bg-grey-10 text-grey-3" rounded>
      <template v-slot:avatar><q-icon name="info" /></template>
      <div class="text-caption">
        Each new message fires the workflow with payload
        <code>{ uid, messageId, from, to, cc, subject, date, text, html, attachments[] }</code>.
        Reference fields in the YAML via <code>${subject}</code>, <code>${from[0]}</code>, <code>${text}</code> etc.
      </div>
    </q-banner>
  </div>
</template>

<script setup>
import { computed, ref } from "vue";

const props = defineProps({
  modelValue: { type: Object, default: () => ({}) },
});
const emit = defineEmits(["update:modelValue"]);

const showPass = ref(false);

const cfg = computed(() => props.modelValue || {});

function emitNext(patch) {
  emit("update:modelValue", { ...cfg.value, ...patch });
}
function set(key, value) {
  emitNext({ [key]: value });
}
function setNumber(key, value) {
  // q-input type=number gives a string; coerce to integer (NaN → undefined).
  const n = parseInt(value, 10);
  emitNext({ [key]: Number.isFinite(n) ? n : undefined });
}
</script>
