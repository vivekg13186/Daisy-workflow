<!--
  Prompt tab — chat-based AI workflow designer.

  The user converses with an agent that has tools to:
    • read what's currently on the canvas (get_current_graph)
    • replace the canvas's working draft (update_graph)
    • list / create triggers
    • list stored configurations

  When the agent calls update_graph, the new DSL flows into the parent's
  v-model so the canvas tab reflects the change immediately. The user
  must still click Save in the toolbar to persist.

  Chat history persists on `model.meta.chat` so reloading the workflow
  brings the conversation back. "New chat" wipes it.
-->
<template>
  <div class="chat-tab column no-wrap full-height q-pa-sm">

    <!-- Header strip ─────────────────────────────────────────────── -->
    <div class="chat-toolbar row items-center q-px-md q-py-sm">
      <q-icon name="auto_awesome" size="20px" class="q-mr-sm" style="color: var(--primary);" />
      <div class="text-subtitle2" style="color: var(--text);">AI workflow designer</div>
      <q-space />
      <span v-if="aiStatus && !aiStatus.configured" class="text-caption text-warning q-mr-sm">
        AI not configured — set ANTHROPIC_API_KEY or OPENAI_API_KEY
      </span>
      <span v-else-if="aiStatus" class="text-caption q-mr-sm" style="color: var(--text-muted);">
        {{ aiStatus.provider }} · {{ aiStatus.model }}
      </span>
      <q-btn
        flat round dense size="sm" icon="restart_alt"
        :disable="messages.length === 0 || sending"
        @click="onNewChat"
      >
        <q-tooltip>Clear chat history</q-tooltip>
      </q-btn>
    </div>

    <!-- Conversation area ────────────────────────────────────────── -->
    <q-scroll-area ref="scrollArea" class="col chat-scroll">
      <div class="chat-list q-pa-md">
        <!-- Welcome card when chat is empty -->
        <div v-if="messages.length === 0" class="welcome-card q-pa-md">
          <div class="text-subtitle1 q-mb-sm" style="color: var(--text);">
            <q-icon name="lightbulb" class="q-mr-xs" />
            Describe the workflow you want
          </div>
          <div class="text-body2 q-mb-md" style="color: var(--text-muted);">
            I have access to every plugin and trigger type in this engine plus your
            stored configurations. Tell me what you want to build, and I'll wire it
            onto the canvas. I can also create triggers once the workflow is saved.
          </div>
          <div class="suggestions-grid">
            <q-chip
              v-for="s in suggestions"
              :key="s"
              clickable
              outline
              size="sm"
              color="primary"
              @click="draft = s; sendMessage()"
            >
              {{ s }}
            </q-chip>
          </div>
        </div>

        <!-- Rendered messages -->
        <template v-for="(m, i) in messages" :key="i">
          <q-chat-message
            :sent="m.role === 'user'"
            :stamp="formatStamp(m.ts)"
            :name="m.role === 'user' ? 'You' : 'Assistant'"
             
            :text-color="m.role === 'user' ? 'black' : undefined"
            class="chat-bubble"
          >
            <div v-if="m.role === 'assistant'" class="assistant-bubble">
              <div class="msg-text" v-html="renderMarkdown(m.content)"></div>
              <div v-if="m.traces?.length" class="trace-strip q-mt-sm">
                <span
                  v-for="(t, j) in m.traces"
                  :key="j"
                  class="trace-chip"
                  :title="formatTraceTitle(t)"
                >
                  <q-icon :name="traceIcon(t.tool)" size="12px" class="q-mr-xs" />
                  {{ traceLabel(t) }}
                </span>
              </div>
              <div v-if="m.proposedGraph" class="applied-banner q-mt-sm">
                <q-icon name="check_circle" size="14px" class="q-mr-xs" />
                Applied <code>{{ m.proposedGraph.name }}</code> to the canvas — switch to the
                <strong>Flow editor</strong> tab to see it. Click <strong>Save</strong> to persist.
              </div>
              <div v-if="m.triggerCreated" class="applied-banner q-mt-sm">
                <q-icon name="bolt" size="14px" class="q-mr-xs" />
                Trigger <code>{{ m.triggerCreated.name }}</code> ({{ m.triggerCreated.type }})
                created and enabled.
              </div>
              <div v-if="m.agentCreated" class="applied-banner q-mt-sm">
                <q-icon name="psychology" size="14px" class="q-mr-xs" />
                Agent <code>{{ m.agentCreated.title }}</code> created — reference it from a node with
                <code>agent: "{{ m.agentCreated.title }}"</code>.
              </div>
            </div>
            <!-- User bubble. Render through marked too so pasted
                 markdown (lists, code fences) renders rather than
                 showing as literal characters. -->
            <div v-else class="msg-text" v-html="renderMarkdown(m.content)"></div>
          </q-chat-message>
        </template>

        <!-- Pending bubble while we wait for the agent -->
        <q-chat-message
          v-if="sending"
          :name="'Assistant'"
          class="chat-bubble"
        >
          <q-spinner-dots size="22px" color="primary" />
        </q-chat-message>

        <q-banner v-if="error" dense class="error-banner q-mt-sm">
          <template v-slot:avatar><q-icon name="error_outline" /></template>
          {{ error }}
        </q-banner>
      </div>
    </q-scroll-area>

    <!-- Composer ─────────────────────────────────────────────────── -->
    <div class="composer q-pa-sm">
      <q-input
        v-model="draft"
        type="textarea"
        autogrow
        outlined dense
        :disable="sending || !aiStatus?.configured"
        placeholder="Describe what you want, ask a question, or say 'add a retry to the http node'…"
        @keydown.enter.exact.prevent="sendMessage"
        
        input-style="max-height: 160px;"
      >
        <template v-slot:after>
          <q-btn
            round dense unelevated
            color="primary"
            icon="send"
            :disable="!canSend"
            :loading="sending"
            @click="sendMessage"
          >
            <q-tooltip>Send (Enter) — Shift+Enter for newline</q-tooltip>
          </q-btn>
        </template>
      </q-input>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, nextTick } from "vue";
import { useQuasar } from "quasar";
import { useRoute } from "vue-router";
import { AI } from "../../api/client";
import { parseDslToModel } from "./flowModel.js";

const props = defineProps({
  modelValue: { type: Object, required: true },
});
const emit = defineEmits(["update:modelValue"]);

const $q = useQuasar();
const route = useRoute();

// ── State ──────────────────────────────────────────────────────────────
const draft     = ref("");
const sending   = ref(false);
const error     = ref("");
const aiStatus  = ref(null);
const scrollArea = ref(null);

// Chat history — stored on model.meta.chat. Mirrored to a local ref so we
// can mutate without churning the parent ref repeatedly during streaming.
const messages = ref([]);

const suggestions = [
  "Build me a workflow that scrapes example.com every hour and emails me when the title changes",
  "Insert a row into my prodDb users table from a webhook payload",
  "Read users.csv, filter active=true rows, and write them back as active.csv",
];

const canSend = computed(() => !sending.value && draft.value.trim().length > 0 && aiStatus.value?.configured);

// ── Lifecycle ──────────────────────────────────────────────────────────
onMounted(async () => {
  try { aiStatus.value = await AI.status(); }
  catch { aiStatus.value = { configured: false }; }

  // Hydrate from saved chat. We pull from props.modelValue.meta.chat on
  // mount; subsequent parent updates are handled via the watcher below.
  if (Array.isArray(props.modelValue?.meta?.chat)) {
    messages.value = props.modelValue.meta.chat.slice();
  }
  await scrollToBottom();
});

// When the parent swaps the entire model (import / archive restore /
// route change), pull in the new chat history.
watch(() => props.modelValue?.id, () => {
  const next = Array.isArray(props.modelValue?.meta?.chat) ? props.modelValue.meta.chat.slice() : [];
  messages.value = next;
});

// ── Send / agent loop ──────────────────────────────────────────────────
async function sendMessage() {
  if (!canSend.value) return;
  error.value = "";
  const text = draft.value.trim();
  draft.value = "";

  // Append user turn locally so it shows immediately.
  const userMsg = { role: "user", content: text, ts: Date.now() };
  messages.value = [...messages.value, userMsg];
  persistMessages();
  await scrollToBottom();

  sending.value = true;
  try {
    const res = await AI.agent({
      messages:     messages.value.map(({ role, content }) => ({ role, content })),
      graphId:      route.params.id && route.params.id !== "new" ? route.params.id : null,
      currentGraph: stripChat(props.modelValue),    // never send the chat history into the prompt
    });

    // If the agent updated the graph, fold its DSL back into the model
    // (preserve our chat history so it doesn't get clobbered).
    let nextModel = props.modelValue;
    if (res.proposedGraph) {
      try {
        const parsed = parseDslToModel(JSON.stringify(res.proposedGraph));
        nextModel = {
          ...parsed,
          meta: { ...(parsed.meta || {}), chat: messages.value },
        };
      } catch (e) {
        // Validation should have happened server-side; this is just defensive.
        $q.notify({ type: "warning", message: `Couldn't apply proposed graph: ${e.message}`, position: "bottom" });
      }
    }

    const asstMsg = {
      role:           "assistant",
      content:        res.message?.content || "",
      ts:             Date.now(),
      traces:         res.traces || [],
      proposedGraph:  res.proposedGraph || null,
      triggerCreated: res.triggerCreated || null,
      agentCreated:   res.agentCreated   || null,
    };
    messages.value = [...messages.value, asstMsg];

    // Push the (maybe new-DSL, maybe same) model + chat back up.
    emit("update:modelValue", {
      ...nextModel,
      meta: { ...(nextModel.meta || {}), chat: messages.value },
    });
  } catch (e) {
    error.value = e?.response?.data?.message || e.message || "Agent call failed";
    // Keep the user's message in history so they can edit + resend without retyping.
  } finally {
    sending.value = false;
    await scrollToBottom();
  }
}

function onNewChat() {
  $q.dialog({
    title:   "Clear chat history?",
    message: "The conversation for this workflow will be discarded. The workflow itself is unaffected.",
    ok:      { label: "Clear", color: "warning", unelevated: true, "no-caps": true },
    cancel:  { label: "Cancel", flat: true, "no-caps": true },
    persistent: true,
  }).onOk(() => {
    messages.value = [];
    emit("update:modelValue", {
      ...props.modelValue,
      meta: { ...(props.modelValue.meta || {}), chat: [] },
    });
  });
}

// ── Helpers ────────────────────────────────────────────────────────────
function persistMessages() {
  emit("update:modelValue", {
    ...props.modelValue,
    meta: { ...(props.modelValue.meta || {}), chat: messages.value },
  });
}

function stripChat(model) {
  if (!model) return null;
  const { meta, ...rest } = model;
  if (!meta) return rest;
  const { chat, ...metaRest } = meta;
  return { ...rest, meta: metaRest };
}

async function scrollToBottom() {
  await nextTick();
  const sa = scrollArea.value;
  if (!sa) return;
  // Quasar's QScrollArea exposes setScrollPosition.
  const target = sa.getScroll().verticalSize;
  sa.setScrollPosition("vertical", target, 100);
}

function formatStamp(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

// Tiny markdown → HTML so code blocks + bold show up. Doesn't pull in
// a full markdown lib; covers the cases the agent reliably emits.
function renderMarkdown(text) {
  if (!text) return "";
  let s = String(text);
  // escape HTML first
  s = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // fenced code blocks
  s = s.replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, body) =>
    `<pre class="md-pre"><code>${body.replace(/\n$/, "")}</code></pre>`);
  // inline code
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  // bold
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // line breaks
  s = s.replace(/\n/g, "<br/>");
  return s;
}

function traceIcon(tool) {
  switch (tool) {
    case "update_graph":      return "edit";
    case "get_current_graph": return "preview";
    case "list_triggers":     return "list";
    case "create_trigger":    return "bolt";
    case "list_configs":      return "key";
    default: return "build";
  }
}

function traceLabel(t) {
  if (t.tool === "update_graph")     return "updated graph";
  if (t.tool === "create_trigger")   return `trigger ${t.input?.name || ""}`;
  if (t.tool === "list_triggers")    return "list triggers";
  if (t.tool === "list_configs")     return "list configs";
  if (t.tool === "get_current_graph") return "read canvas";
  return t.tool;
}

function formatTraceTitle(t) {
  return `${t.tool}: ${t.summary || ""}`;
}
</script>

<style scoped>
 
.chat-toolbar {
  background: var(--surface-2);
  border-bottom: 1px solid var(--border);
}
.chat-scroll {
  background: var(--bg);
}
.chat-list {
  max-width: 920px;
  margin: 0 auto;
}

/* Welcome card shown when the chat is empty */
.welcome-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  margin-bottom: 16px;
}
.suggestions-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

/* Bubbles */
.chat-bubble :deep(.q-message-text) {
  background: var(--surface);
  color: var(--text);
}
/* User-sent bubble. Previously used var(--primary) which read as a
   heavy dark-blue block against the surface; we want a softer
   white-on-bordered card. Mirrors the OrchestratorChat dialog. */
.chat-bubble :deep(.q-message-sent .q-message-text) {
  background: #ffffff;
  color: var(--text);
  border: 1px solid var(--border);
}
html[data-theme="dark"] .chat-bubble :deep(.q-message-sent .q-message-text) {
  background: #f1f5f9;
  color: #0f172a;
}
/* Assistant bubble in dark mode. The default `.q-message-text` color from
   Quasar leaks through and reads as dark-on-dark; pin it explicitly. */
html[data-theme="dark"] .chat-bubble :deep(.q-message-received .q-message-text) {
  background: #1e293b;
  color: #e2e8f0;
  border: 1px solid #334155;
}
html[data-theme="dark"] .chat-bubble :deep(.q-message-received .q-message-text-content) {
  color: #e2e8f0;
}
.assistant-bubble {
  line-height: 1.45;
}
/* Compress markdown headings — browser defaults (2em, 1.5em…) are
   wildly oversized inside a chat bubble. Keep the visual hierarchy
   but at chat-friendly font sizes. */
.msg-text :deep(h1),
.msg-text :deep(h2),
.msg-text :deep(h3),
.msg-text :deep(h4),
.msg-text :deep(h5),
.msg-text :deep(h6) {
  margin: 10px 0 4px;
  font-weight: 600;
  line-height: 1.3;
}
.msg-text :deep(h1) { font-size: 1.05rem; }
.msg-text :deep(h2) { font-size: 1rem;    }
.msg-text :deep(h3) { font-size: 0.95rem; }
.msg-text :deep(h4),
.msg-text :deep(h5),
.msg-text :deep(h6) { font-size: 0.9rem;  }
.msg-text :deep(h1:first-child),
.msg-text :deep(h2:first-child),
.msg-text :deep(h3:first-child),
.msg-text :deep(h4:first-child),
.msg-text :deep(h5:first-child),
.msg-text :deep(h6:first-child) { margin-top: 0; }
.msg-text :deep(p) { margin: 0 0 8px; }
.msg-text :deep(p:last-child) { margin-bottom: 0; }
.msg-text :deep(ul),
.msg-text :deep(ol) { margin: 4px 0 8px; padding-left: 20px; }
.msg-text :deep(li) { margin: 2px 0; }
.msg-text :deep(code) {
  background: rgba(0,0,0,0.06);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 12px;
  font-family: ui-monospace, Menlo, Consolas, monospace;
}
.msg-text :deep(.md-pre) {
  margin: 8px 0;
  padding: 8px 10px;
  background: rgba(0,0,0,0.06);
  border-radius: 4px;
  overflow-x: auto;
  font-size: 12.5px;
}
.msg-text :deep(.md-pre code) {
  background: transparent;
  padding: 0;
}

/* Trace strip — small chips under an assistant message showing what tools fired */
.trace-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  font-size: 11px;
}
.trace-chip {
  display: inline-flex;
  align-items: center;
  background: rgba(0,0,0,0.05);
  color: var(--text-muted);
  padding: 1px 7px;
  border-radius: 9999px;
  border: 1px solid var(--border);
}

/* Banner shown when the agent applied a graph or created a trigger */
.applied-banner {
  display: inline-flex;
  align-items: center;
  background: var(--success-soft);
  color: var(--success);
  border: 1px solid var(--success);
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 12.5px;
}

.error-banner {
  background: var(--danger-soft);
  color: var(--danger);
  border: 1px solid var(--danger);
}

/* Composer */
.composer {
  background: var(--surface);
  border-top: 1px solid var(--border);
}

code {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 12px;
}
</style>
