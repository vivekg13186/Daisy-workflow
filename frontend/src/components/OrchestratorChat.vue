<!--
  Centralised Ask-Agent chat.
  =========================
  One chat surface that can produce workflows, AI agents, and plugins
  from a single conversation. Replaces the per-context "Ask AI" entry
  points scattered through the editor / Plugins page; those become
  re-launchers for this dialog over time.
  =========================

  Lifecycle is intentionally transient. The conversation lives only in
  this component's reactive state — nothing persists to a workflow's
  `meta.chat` or the DB. Users can hit Download to save the chat as a
  markdown file; otherwise the conversation is lost when the modal
  closes. That matches the user mental model of "scratchpad authoring":
  use the chat to sketch the right artifacts, save the ones you like,
  throw the conversation away.

  Artifact handling:
    • When the assistant reply carries `proposedGraph` (today, single
      workflow per turn — multi-artifact bundles arrive in a later
      backend pass), we render an artifact card with a Save button.
      Clicking Save calls `Graphs.create(dsl)` and reloads the
      Workflows list.
    • Agent + plugin artifacts ride the same `proposedAgents` /
      `proposedPlugins` fields once the backend tool-use loop is
      extended to emit them. The card UI is stubbed for both so the
      shape is in place.

  Bubble colour was previously `var(--primary)` for user-sent bubbles,
  which read as dark blue on light theme and looked heavy on dark
  theme too. Now a neutral white surface with a soft border so the
  message reads as a card, not a block of brand colour.
-->

<template>
  <q-dialog
    :model-value="modelValue"
    @update:model-value="$emit('update:modelValue', $event)"
    persistent
    maximized
    transition-show="slide-up"
    transition-hide="slide-down"
  >
    <q-card class="orchestrator-card column no-wrap">
      <!-- Header strip ────────────────────────────────────────────── -->
      <q-toolbar class="orchestrator-toolbar">
        <q-icon name="auto_awesome" size="22px" style="color: var(--primary);" />
        <q-toolbar-title class="q-ml-sm">
          Ask Agent
          <span class="text-caption q-ml-sm" style="color: var(--text-muted);">
            describe what you want — workflows, agents, or plugins
          </span>
        </q-toolbar-title>
        <q-space />

        <span v-if="aiStatus && !aiStatus.configured" class="text-caption q-mr-md" style="color: var(--warning);">
          AI not configured — set ANTHROPIC_API_KEY or OPENAI_API_KEY
        </span>
        <span v-else-if="aiStatus" class="text-caption q-mr-md" style="color: var(--text-muted);">
          {{ aiStatus.provider }} · {{ aiStatus.model }}
        </span>

        <q-btn
          flat dense round icon="download"
          :disable="!messages.length"
          @click="downloadConversation"
        >
          <q-tooltip>Download conversation as .md</q-tooltip>
        </q-btn>
        <q-btn
          flat dense round icon="restart_alt"
          :disable="!messages.length || sending"
          @click="onNewChat"
        >
          <q-tooltip>Clear chat</q-tooltip>
        </q-btn>
        <q-btn flat dense round icon="close" @click="onClose">
          <q-tooltip>Close (chat will be lost — Download first to keep it)</q-tooltip>
        </q-btn>
      </q-toolbar>

      <!-- Conversation area ───────────────────────────────────────── -->
      <q-scroll-area ref="scrollArea" class="col conv-scroll">
        <div class="conv-list q-pa-lg">
          <div v-if="!messages.length" class="welcome-card q-pa-md">
            <div class="text-subtitle1 q-mb-sm" style="color: var(--text);">
              <q-icon name="lightbulb" class="q-mr-xs" />
              What would you like to build?
            </div>
            <div class="text-body2 q-mb-md" style="color: var(--text-muted);">
              I have access to the live plugin registry, your stored configurations, and
              I can draft workflows, AI agent personas, and new plugins.
              Paste a multi-step description and I'll break it down.
            </div>
            <div class="suggestions-grid">
              <q-chip
                v-for="s in suggestions"
                :key="s.short"
                clickable
                outline
                size="sm"
                color="primary"
                @click="draft = s.full; sendMessage();"
              >
                {{ s.short }}
              </q-chip>
            </div>
          </div>

          <template v-for="(m, i) in messages" :key="i">
            <div class="msg-row" :class="m.role === 'user' ? 'msg-row-user' : 'msg-row-assistant'">
              <div class="msg-meta">
                <q-icon
                  :name="m.role === 'user' ? 'person' : 'auto_awesome'"
                  size="16px"
                  :style="`color: ${m.role === 'user' ? 'var(--text-muted)' : 'var(--primary)'};`"
                />
                <span class="msg-name">{{ m.role === 'user' ? 'You' : 'Agent' }}</span>
                <span class="msg-stamp">{{ formatStamp(m.ts) }}</span>
              </div>

              <!-- The actual bubble. White-surface for the user message
                   matches the spec; assistant gets the same surface
                   colour but no border so the two read distinctly. Both
                   roles render through marked so the user can paste
                   markdown (lists, code fences, bold) and see it
                   formatted rather than escaped. -->
              <div
                class="bubble"
                :class="m.role === 'user' ? 'bubble-user' : 'bubble-assistant'"
              >
                <div class="bubble-text" v-html="renderMarkdown(m.content)"></div>

                <!-- Server-side side effects (already saved in DB).
                     create_workflow / create_agent / create_trigger don't
                     produce a draft to review — they execute the change
                     and we just confirm. Distinct from the proposed-*
                     cards below which DO have a Save button. -->
                <div
                  v-for="(w, j) in (m.workflowsCreated || [])"
                  :key="`wc-${i}-${j}`"
                  class="success-strip"
                >
                  <q-icon name="check_circle" size="14px" class="q-mr-xs" />
                  Workflow <code>{{ w.name }}</code> saved.
                  <a
                    href="#"
                    class="q-ml-sm"
                    @click.prevent="openWorkflow(w.id)"
                  >Open in editor →</a>
                </div>
                <div v-if="m.role === 'assistant' && m.agentCreated" class="success-strip">
                  <q-icon name="check_circle" size="14px" class="q-mr-xs" />
                  Agent <code>{{ m.agentCreated.title }}</code> created.
                  Reference it from a workflow with
                  <code>agent: "{{ m.agentCreated.title }}"</code>.
                </div>
                <div v-if="m.role === 'assistant' && m.triggerCreated" class="success-strip">
                  <q-icon name="check_circle" size="14px" class="q-mr-xs" />
                  Trigger <code>{{ m.triggerCreated.name }}</code>
                  ({{ m.triggerCreated.type }}) created and enabled.
                </div>

                <!-- Plugin hand-off card. The orchestrator agent can't
                     build plugins itself (admin-only generator that
                     requires operator review). When the user asks for a
                     new plugin, the backend's request_plugin tool fires
                     and the model emits a refined prompt; we show a
                     dedicated card that opens the Plugin Generator on
                     the Plugins admin page with the prompt pre-filled. -->
                <div v-if="m.role === 'assistant' && m.pluginRequest" class="handoff-card">
                  <div class="handoff-head">
                    <q-icon name="extension" size="16px" class="q-mr-xs" />
                    <span class="handoff-title">
                      New plugin request
                    </span>
                    <q-space />
                    <q-btn
                      unelevated dense size="sm" no-caps color="primary"
                      icon-right="open_in_new"
                      label="Open Plugin Generator"
                      @click="openPluginGenerator(m.pluginRequest)"
                    />
                  </div>
                  <div v-if="m.pluginRequest.summary" class="handoff-summary">
                    {{ m.pluginRequest.summary }}
                  </div>
                  <pre class="handoff-prompt">{{ m.pluginRequest.prompt }}</pre>
                </div>

                <!-- Tool-use trace strip (assistant turns only). -->
                <div v-if="m.role === 'assistant' && m.traces?.length" class="trace-strip">
                  <span
                    v-for="(t, j) in m.traces"
                    :key="j"
                    class="trace-chip"
                    :title="formatTraceTitle(t)"
                  >
                    <q-icon :name="traceIcon(t.tool)" size="11px" class="q-mr-xs" />
                    {{ t.tool }}
                  </span>
                </div>

                <!-- Proposed artifacts — workflow card. -->
                <div v-if="m.role === 'assistant' && m.proposedGraph" class="artifact-card">
                  <div class="artifact-head">
                    <q-icon name="schema" size="16px" class="q-mr-xs" />
                    <span class="artifact-title">Workflow: <code>{{ m.proposedGraph.name }}</code></span>
                    <q-space />
                    <q-btn
                      unelevated dense size="sm" no-caps color="primary"
                      :loading="savingArtifact === `wf-${i}`"
                      :disable="!!savedArtifacts[`wf-${i}`]"
                      :label="savedArtifacts[`wf-${i}`] ? 'Saved' : 'Save as workflow'"
                      @click="saveWorkflow(i, m.proposedGraph)"
                    />
                  </div>
                  <pre class="artifact-body">{{ formatJson(m.proposedGraph) }}</pre>
                </div>

                <!-- Proposed agents (the cognitive personas — backend will
                     emit these once the tool-use loop adds a create_agent
                     tool; until then the card path is dormant). -->
                <div
                  v-for="(a, j) in (m.proposedAgents || [])"
                  :key="`a-${j}`"
                  class="artifact-card"
                >
                  <div class="artifact-head">
                    <q-icon name="psychology" size="16px" class="q-mr-xs" />
                    <span class="artifact-title">Agent: <code>{{ a.title }}</code></span>
                    <q-space />
                    <q-btn
                      unelevated dense size="sm" no-caps color="primary"
                      :loading="savingArtifact === `ag-${i}-${j}`"
                      :disable="!!savedArtifacts[`ag-${i}-${j}`]"
                      :label="savedArtifacts[`ag-${i}-${j}`] ? 'Saved' : 'Save as agent'"
                      @click="saveAgent(i, j, a)"
                    />
                  </div>
                  <pre class="artifact-body">{{ formatJson(a) }}</pre>
                </div>

                <!-- Proposed plugin scaffolds (full project tree). The
                     existing Ask-Agent-on-Plugins-page implementation
                     produces the same shape; reusing the same client
                     method keeps semantics consistent. -->
                <div
                  v-for="(p, j) in (m.proposedPlugins || [])"
                  :key="`p-${j}`"
                  class="artifact-card"
                >
                  <div class="artifact-head">
                    <q-icon name="extension" size="16px" class="q-mr-xs" />
                    <span class="artifact-title">Plugin: <code>{{ p.name }}</code></span>
                    <q-space />
                    <q-btn
                      flat dense size="sm" no-caps icon="download"
                      label="Download zip"
                      :loading="savingArtifact === `pl-${i}-${j}`"
                      @click="downloadPluginZip(i, j, p)"
                    />
                  </div>
                  <div class="artifact-body-summary">
                    {{ p.files?.length || 0 }} files · {{ p.summary || "no summary" }}
                  </div>
                </div>
              </div>
            </div>
          </template>

          <div v-if="sending" class="msg-row msg-row-assistant">
            <div class="msg-meta">
              <q-icon name="auto_awesome" size="16px" style="color: var(--primary);" />
              <span class="msg-name">Agent</span>
            </div>
            <div class="bubble bubble-assistant">
              <q-spinner-dots size="22px" color="primary" />
            </div>
          </div>

          <q-banner v-if="error" dense class="error-banner">
            <template v-slot:avatar><q-icon name="error_outline" /></template>
            {{ error }}
          </q-banner>
        </div>
      </q-scroll-area>

      <!-- Composer ─────────────────────────────────────────────────── -->
      <div class="composer q-pa-md">
        <q-input
          v-model="draft"
          type="textarea"
          autogrow
          outlined dense
          :disable="sending || !aiStatus?.configured"
          placeholder="Describe what you want. E.g. 'Read emails every morning at 8am, classify the intent, and start a query-handler workflow for customer questions.'"
          @keydown.enter.exact.prevent="sendMessage"
          input-style="max-height: 200px;"
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
        <div class="text-caption q-mt-xs" style="color: var(--text-muted);">
          Conversations are not saved. <strong>Download</strong> the chat first if you want to keep it.
        </div>
      </div>
    </q-card>
  </q-dialog>
</template>

<script setup>
import { ref, reactive, computed, watch, nextTick } from "vue";
import { useQuasar } from "quasar";
import { useRouter } from "vue-router";
import { marked } from "marked";
import { AI, Graphs, Agents, Plugins } from "../api/client.js";

const props = defineProps({
  modelValue: { type: Boolean, default: false },
});
const emit = defineEmits(["update:modelValue", "saved"]);

const $q     = useQuasar();
const router = useRouter();

// ── State ──────────────────────────────────────────────────────────────
const draft     = ref("");
const sending   = ref(false);
const error     = ref("");
const aiStatus  = ref(null);
const scrollArea = ref(null);

// Conversation lives in component state only — no persistence. User
// must Download to keep a record.
const messages  = ref([]);

// Per-artifact bookkeeping so the same Save button doesn't re-fire.
const savedArtifacts = reactive({});
const savingArtifact = ref("");

// Three starters. The first one is the user's own canonical example —
// the multi-workflow / multi-agent / multi-plugin pattern.
const suggestions = [
  {
    short: "Inbox triage with auto-replies (2 workflows + an agent)",
    full:
      "Create a workflow that reads emails every day at 8am from the support inbox. " +
      "For each new email, classify the intent with an AI agent. If it looks like a customer query, " +
      "start a second workflow called \"Query Handler\" with the email content. " +
      "In Query Handler, show the email_subject, email_body, and email_from to a human, let them type a response, " +
      "and send that response to the customer via email.",
  },
  {
    short: "Daily scrape diff + email digest",
    full:
      "Every morning at 9am, scrape a list of competitor pricing pages. " +
      "Compare today's prices to yesterday's (stored in memory). " +
      "Email me a summary if anything changed.",
  },
  {
    short: "Build me a Slack plugin",
    full:
      "Generate a plugin that posts a message to a Slack channel via webhook. " +
      "Inputs: channel, message. Output: ok + posted-at timestamp.",
  },
];

const canSend = computed(
  () => !sending.value && draft.value.trim().length > 0 && aiStatus.value?.configured,
);

watch(
  () => props.modelValue,
  async (open) => {
    if (!open) return;
    if (!aiStatus.value) {
      try { aiStatus.value = await AI.status(); }
      catch { aiStatus.value = { configured: false }; }
    }
    await scrollToBottom();
  },
);

// ── Send / receive ─────────────────────────────────────────────────────
async function sendMessage() {
  const text = draft.value.trim();
  if (!text || sending.value) return;

  // Push the user turn first so the bubble shows immediately.
  messages.value.push({ role: "user", content: text, ts: Date.now() });
  draft.value = "";
  sending.value = true;
  error.value = "";
  await scrollToBottom();

  try {
    // Reuse the existing tool-using agent endpoint. The backend's
    // tool-use loop today handles workflows + triggers; multi-agent
    // and plugin generation tools land in a follow-up backend pass
    // so the response shape is forward-compatible.
    const wire = messages.value.map(m => ({ role: m.role, content: m.content }));
    const r = await AI.agent({
      messages:     wire,
      graphId:      null,
      currentGraph: null,
    });

    messages.value.push({
      role:             "assistant",
      content:          r?.message?.content || "",
      ts:               Date.now(),
      traces:           r?.traces || [],
      // proposedGraph is the editor-mode preview (validated DSL the user
      // would Save themselves). In the global Ask Agent surface the
      // backend uses create_workflow instead, which actually persists,
      // and surfaces those rows in workflowsCreated.
      proposedGraph:    r?.proposedGraph    || null,
      workflowsCreated: r?.workflowsCreated || [],
      // Forward-compatible: backend will populate proposedPlugins when
      // the tool-use loop learns to draft plugin scaffolds.
      proposedAgents:   r?.proposedAgents   || [],
      proposedPlugins:  r?.proposedPlugins  || [],
      triggerCreated:   r?.triggerCreated   || null,
      agentCreated:     r?.agentCreated     || null,
      pluginRequest:    r?.pluginRequest    || null,
    });

    // Notify the parent (HomePage) so its tables refresh. Every server-
    // side create_* emits a 'saved' event the parent listens to via
    // onOrchestratorSaved → reload().
    for (const w of (r?.workflowsCreated || [])) {
      emit("saved", { kind: "workflow", id: w.id, name: w.name });
    }
    if (r?.agentCreated) {
      emit("saved", {
        kind:  "agent",
        id:    r.agentCreated.id,
        title: r.agentCreated.title,
      });
    }
    if (r?.triggerCreated) {
      emit("saved", {
        kind: "trigger",
        id:   r.triggerCreated.id,
        name: r.triggerCreated.name,
      });
    }
  } catch (e) {
    error.value = e?.response?.data?.message || e?.message || "Request failed";
    // Don't echo a stub assistant turn on error; the banner above is enough.
  } finally {
    sending.value = false;
    await scrollToBottom();
  }
}

// ── Artifact handlers ──────────────────────────────────────────────────
async function saveWorkflow(msgIdx, graph) {
  const key = `wf-${msgIdx}`;
  if (savedArtifacts[key] || savingArtifact.value) return;
  savingArtifact.value = key;
  try {
    const created = await Graphs.create(graph);
    savedArtifacts[key] = created.id;
    $q.notify({ type: "positive", message: `Workflow "${graph.name}" saved`, timeout: 1800 });
    emit("saved", { kind: "workflow", id: created.id, name: graph.name });
  } catch (e) {
    $q.notify({ type: "negative", message: `Save failed: ${errMsg(e)}`, timeout: 4000 });
  } finally {
    savingArtifact.value = "";
  }
}

async function saveAgent(msgIdx, agentIdx, agent) {
  const key = `ag-${msgIdx}-${agentIdx}`;
  if (savedArtifacts[key] || savingArtifact.value) return;
  savingArtifact.value = key;
  try {
    const created = await Agents.create(agent);
    savedArtifacts[key] = created.id;
    $q.notify({ type: "positive", message: `Agent "${agent.title}" saved`, timeout: 1800 });
    emit("saved", { kind: "agent", id: created.id, title: agent.title });
  } catch (e) {
    $q.notify({ type: "negative", message: `Save failed: ${errMsg(e)}`, timeout: 4000 });
  } finally {
    savingArtifact.value = "";
  }
}

async function downloadPluginZip(msgIdx, pluginIdx, plugin) {
  const key = `pl-${msgIdx}-${pluginIdx}`;
  savingArtifact.value = key;
  try {
    const blob = await Plugins.downloadAgentZip({
      name:  plugin.name,
      files: plugin.files,
    });
    const url = URL.createObjectURL(blob);
    const a   = document.createElement("a");
    a.href     = url;
    a.download = `${plugin.name}-plugin.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (e) {
    $q.notify({ type: "negative", message: `Download failed: ${errMsg(e)}`, timeout: 4000 });
  } finally {
    savingArtifact.value = "";
  }
}

// ── Misc helpers ───────────────────────────────────────────────────────
function onNewChat() {
  messages.value = [];
  error.value = "";
  Object.keys(savedArtifacts).forEach(k => delete savedArtifacts[k]);
}
function onClose() { emit("update:modelValue", false); }

// Jump from a saved-workflow chip into the full editor. Closes the
// orchestrator dialog first so the route push isn't competing with a
// modal teleport stack.
function openWorkflow(id) {
  emit("update:modelValue", false);
  // nextTick so the dialog has time to start hiding before the route push.
  nextTick(() => router.push({ path: `/flowDesigner/${id}` }));
}

// Hand off a plugin request to the dedicated Plugin Generator on the
// Plugins admin page. We pass the prompt + transport as query params;
// PluginsPage's onMounted hook picks them up and opens the Ask-Agent
// dialog with the prompt pre-filled, so the user doesn't have to copy
// it across themselves.
function openPluginGenerator(req) {
  if (!req?.prompt) return;
  emit("update:modelValue", false);
  nextTick(() => router.push({
    path: "/plugins",
    query: {
      askPrompt:    req.prompt,
      askTransport: req.transport || "http",
    },
  }));
}

async function scrollToBottom() {
  await nextTick();
  try { scrollArea.value?.setScrollPercentage("vertical", 1, 200); } catch { /* ok */ }
}

function renderMarkdown(s) {
  try { return marked.parse(String(s || ""), { breaks: true }); }
  catch { return escapeHtml(s); }
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function formatStamp(ts)      { try { return new Date(ts).toLocaleTimeString(); } catch { return ""; } }
function formatJson(o)        { try { return JSON.stringify(o, null, 2); } catch { return String(o); } }
function formatTraceTitle(t)  { return `${t.tool} — ${t.summary || ""}`; }
function traceIcon(tool) {
  if (/graph/i.test(tool))   return "schema";
  if (/agent/i.test(tool))   return "psychology";
  if (/plugin/i.test(tool))  return "extension";
  if (/trigger/i.test(tool)) return "bolt";
  if (/config/i.test(tool))  return "settings_input_component";
  return "build";
}
function errMsg(e) { return e?.response?.data?.message || e?.message || "unknown error"; }

// ── Conversation download ──────────────────────────────────────────────
function downloadConversation() {
  if (!messages.value.length) return;
  const lines = [
    `# Ask Agent — conversation`,
    "",
    `*Exported: ${new Date().toISOString()}*`,
    "",
    "---",
    "",
  ];
  for (const m of messages.value) {
    const who = m.role === "user" ? "**You**" : "**Agent**";
    const stamp = m.ts ? ` _(${new Date(m.ts).toLocaleString()})_` : "";
    lines.push(`### ${who}${stamp}`);
    lines.push("");
    lines.push(m.content || "");
    lines.push("");
    if (m.proposedGraph) {
      lines.push("```json");
      lines.push(`// Proposed workflow: ${m.proposedGraph.name}`);
      lines.push(JSON.stringify(m.proposedGraph, null, 2));
      lines.push("```");
      lines.push("");
    }
    for (const w of (m.workflowsCreated || [])) {
      lines.push(`> Workflow saved: \`${w.name}\` (id ${w.id})`);
      lines.push("");
    }
    if (m.agentCreated) {
      lines.push(`> Agent created: \`${m.agentCreated.title}\` (id ${m.agentCreated.id})`);
      lines.push("");
    }
    if (m.triggerCreated) {
      lines.push(`> Trigger created: \`${m.triggerCreated.name}\` (${m.triggerCreated.type}, id ${m.triggerCreated.id})`);
      lines.push("");
    }
    if (m.pluginRequest) {
      lines.push(`> Plugin hand-off prepared (transport: ${m.pluginRequest.transport}). Prompt for the Plugin Generator:`);
      lines.push("");
      lines.push("```");
      lines.push(m.pluginRequest.prompt);
      lines.push("```");
      lines.push("");
    }
    for (const a of (m.proposedAgents || [])) {
      lines.push("```json");
      lines.push(`// Proposed agent: ${a.title}`);
      lines.push(JSON.stringify(a, null, 2));
      lines.push("```");
      lines.push("");
    }
    for (const p of (m.proposedPlugins || [])) {
      lines.push("```json");
      lines.push(`// Proposed plugin: ${p.name}`);
      lines.push(JSON.stringify({ name: p.name, summary: p.summary, fileCount: p.files?.length || 0 }, null, 2));
      lines.push("```");
      lines.push("");
    }
    lines.push("---");
    lines.push("");
  }
  const text = lines.join("\n");
  const blob = new Blob([text], { type: "text/markdown" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `ask-agent-${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
</script>

<style scoped>
.orchestrator-card {
  background: var(--bg);
  color: var(--text);
}
.orchestrator-toolbar {
  background: var(--surface);
  color: var(--text);
  border-bottom: 1px solid var(--border);
  min-height: 52px;
  padding: 0 16px;
}

.conv-scroll { background: var(--bg); }
.conv-list   { max-width: 880px; margin: 0 auto; }

.welcome-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
}
.suggestions-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

/* Message rows — one bubble per turn, with a meta strip above. */
.msg-row {
  display: flex;
  flex-direction: column;
  margin-bottom: 18px;
}
.msg-row-user        { align-items: flex-end; }
.msg-row-assistant   { align-items: flex-start; }

.msg-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 4px;
}
.msg-name  { font-weight: 600; }
.msg-stamp { color: var(--text-soft); margin-left: 4px; }

/* Bubbles — the user's was previously dark blue (var(--primary)).
   Now both bubbles use a neutral surface; the user one carries a
   subtle border so it still reads as outgoing. */
.bubble {
  max-width: 720px;
  padding: 10px 14px;
  border-radius: 14px;
  background: var(--surface);
  color: var(--text);
  box-shadow: var(--shadow-sm);
  line-height: 1.45;
}
.bubble-user {
  background: #ffffff;
  color: #000 !important;
  border: 1px solid var(--border);
  border-top-right-radius: 4px;
}
.bubble-assistant {
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--border);
  border-top-left-radius: 4px;
}
html[data-theme="dark"] .bubble-user {
  /* On dark theme, "white" reads as glaring — drop to a near-white
     so the contrast is right but the bubble still pops as outgoing. */
  background: #f1f5f9;
  color: #0f172a;
}
/* Assistant bubble in dark mode. Without this override the scoped/teleported
   bubble was inheriting a near-black text color from somewhere up the tree
   and reading as dark-on-dark; pin the text to the dark-mode --text token
   explicitly to guarantee contrast against the slate surface. */
html[data-theme="dark"] .bubble-assistant {
  background: #1e293b;
  color: #e2e8f0;
  border-color: #334155;
}
html[data-theme="dark"] .bubble-assistant :deep(p),
html[data-theme="dark"] .bubble-assistant :deep(li),
html[data-theme="dark"] .bubble-assistant :deep(strong),
html[data-theme="dark"] .bubble-assistant :deep(em),
html[data-theme="dark"] .bubble-assistant :deep(h1),
html[data-theme="dark"] .bubble-assistant :deep(h2),
html[data-theme="dark"] .bubble-assistant :deep(h3),
html[data-theme="dark"] .bubble-assistant :deep(h4),
html[data-theme="dark"] .bubble-assistant :deep(h5),
html[data-theme="dark"] .bubble-assistant :deep(h6) {
  color: #e2e8f0;
}
html[data-theme="dark"] .bubble-assistant :deep(code) {
  background: rgba(255, 255, 255, 0.08);
  color: #f1f5f9;
}
html[data-theme="dark"] .bubble-assistant :deep(pre) {
  background: #0f172a;
  border-color: #334155;
  color: #e2e8f0;
}

.bubble-text :deep(p)     { margin: 0 0 8px; }
.bubble-text :deep(p:last-child) { margin-bottom: 0; }
/* Markdown headings — default browser sizing (2em, 1.5em, …) blows
   the bubble out. Compress them into a tight chat-friendly scale
   while still keeping a clear visual hierarchy. */
.bubble-text :deep(h1),
.bubble-text :deep(h2),
.bubble-text :deep(h3),
.bubble-text :deep(h4),
.bubble-text :deep(h5),
.bubble-text :deep(h6) {
  margin: 10px 0 4px;
  font-weight: 600;
  line-height: 1.3;
  color: #000 !important;
}
.bubble-text :deep(h1) { font-size: 1.05rem; }
.bubble-text :deep(h2) { font-size: 1rem;    }
.bubble-text :deep(h3) { font-size: 0.95rem; }
.bubble-text :deep(h4),
.bubble-text :deep(h5),
.bubble-text :deep(h6) { font-size: 0.9rem;  }
.bubble-text :deep(h1:first-child),
.bubble-text :deep(h2:first-child),
.bubble-text :deep(h3:first-child),
.bubble-text :deep(h4:first-child),
.bubble-text :deep(h5:first-child),
.bubble-text :deep(h6:first-child) { margin-top: 0; }
.bubble-text :deep(ul),
.bubble-text :deep(ol) { margin: 4px 0 8px; padding-left: 20px; }
.bubble-text :deep(li) { margin: 2px 0; }
.bubble-text :deep(code) {
  background: var(--primary-soft);
  color: #000 ;
  padding: 0 4px;
  border-radius: 3px;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 0.92em;
}
.bubble-text :deep(pre) {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 10px 12px;
  overflow-x: auto;
  font-size: 12px;
}

/* Inline confirmation banner shown when a server-side tool (create_agent /
   create_trigger) actually made a change. Distinct from artifact cards
   below — those are drafts the user still needs to save. */
.success-strip {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-top: 8px;
  padding: 6px 10px;
  background: var(--success-soft, rgba(34, 197, 94, 0.1));
  color: var(--success, #15803d);
  border: 1px solid var(--success, #15803d);
  border-radius: var(--radius);
  font-size: 12.5px;
  line-height: 1.4;
}
.success-strip code {
  background: rgba(255, 255, 255, 0.4);
  padding: 0 4px;
  border-radius: 3px;
  font-family: ui-monospace, Menlo, Consolas, monospace;
}
.success-strip a {
  color: inherit;
  text-decoration: underline;
  font-weight: 500;
}
html[data-theme="dark"] .success-strip {
  background: rgba(34, 197, 94, 0.15);
  color: #4ade80;
  border-color: #22c55e;
}
html[data-theme="dark"] .success-strip code {
  background: rgba(0, 0, 0, 0.3);
  color: #bbf7d0;
}

/* Tool-use trace chips below the assistant text. */
.trace-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 8px;
}
.trace-chip {
  display: inline-flex;
  align-items: center;
  background: var(--surface-2);
  color: var(--text-muted);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
}

/* Artifact cards (workflow / agent / plugin) */
.artifact-card {
  margin-top: 12px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}
.artifact-head {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}
.artifact-title { font-size: 13px; font-weight: 600; color: var(--text); }
.artifact-body {
  margin: 0;
  padding: 10px 12px;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 11.5px;
  max-height: 300px;
  overflow: auto;
  white-space: pre;
  background: var(--surface-2);
  color: var(--text);
}
.artifact-body-summary {
  padding: 10px 12px;
  font-size: 12px;
  color: var(--text-muted);
}

/* Plugin hand-off card. Visually similar to the artifact-card but
   with an accent border to flag "this is a hand-off, not something I
   built" so users don't mistake it for a saved artifact. */
.handoff-card {
  margin-top: 12px;
  background: var(--surface-2);
  border: 1px solid var(--primary);
  border-left-width: 3px;
  border-radius: var(--radius);
  overflow: hidden;
}
.handoff-head {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  background: var(--primary-soft);
  border-bottom: 1px solid var(--border);
}
.handoff-title { font-size: 13px; font-weight: 600; color: var(--text); }
.handoff-summary {
  padding: 10px 12px;
  font-size: 13px;
  color: var(--text);
  border-bottom: 1px dashed var(--border);
}
.handoff-prompt {
  margin: 0;
  padding: 10px 12px;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 11.5px;
  max-height: 200px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--surface-2);
  color: var(--text-muted);
}

.composer {
  background: var(--surface);
  border-top: 1px solid var(--border);
}
.error-banner {
  background: var(--danger-soft);
  color: var(--danger);
  margin-top: 12px;
  border-radius: var(--radius);
}
</style>
