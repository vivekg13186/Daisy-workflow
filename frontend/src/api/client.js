import axios from "axios";

const api = axios.create({ baseURL: "/api" });

// `dsl` is the JSON-serialised DAG (formerly YAML). The backend keeps a
// `yaml` alias on its request handlers for back-compat, but new clients
// should always use `dsl`.
//
// Workflows are now single-row — the `id` is stable across saves and
// PUT updates the same row in place. Snapshots are explicit via the
// archive endpoints below.
export const Graphs = {
  list:     () => api.get("/graphs").then(r => r.data),
  get:      (id) => api.get(`/graphs/${id}`).then(r => r.data),
  create:   (dsl) => api.post("/graphs", { dsl }).then(r => r.data),
  update:   (id, dsl) => api.put(`/graphs/${id}`, { dsl }).then(r => r.data),
  remove:   (id) => api.delete(`/graphs/${id}`).then(r => r.data),
  validate: (dsl) => api.post("/graphs/validate", { dsl }).then(r => r.data),
  execute:  (id, context = {}) => api.post(`/graphs/${id}/execute`, { context }).then(r => r.data),

  // Archives — explicit snapshots of the live workflow.
  archive:    (id, reason) => api.post(`/graphs/${id}/archives`, { reason }).then(r => r.data),
  archives:   (id) => api.get(`/graphs/${id}/archives`).then(r => r.data),
  archiveGet: (id, archiveId) => api.get(`/graphs/${id}/archives/${archiveId}`).then(r => r.data),
  restore:    (id, archiveId) =>
    api.post(`/graphs/${id}/archives/${archiveId}/restore`).then(r => r.data),
};

export const Executions = {
  // Optional filters: { graphId, status (CSV: "running,queued"), limit }.
  // Legacy callers pass a bare graphId string — still supported.
  list: (filterOrGraphId) => {
    const params = (typeof filterOrGraphId === "string" || filterOrGraphId == null)
      ? (filterOrGraphId ? { graphId: filterOrGraphId } : {})
      : filterOrGraphId;
    return api.get("/executions", { params }).then(r => r.data);
  },
  get:    (id) => api.get(`/executions/${id}`).then(r => r.data),
  remove: (id) => api.delete(`/executions/${id}`),
};

export const Plugins = {
  // Returns [{ name, description, inputSchema, outputSchema }]
  list: () => api.get("/plugins").then(r => r.data),
};

export const AI = {
  // { configured, provider, model }
  status: () => api.get("/ai/status").then(r => r.data),
  // messages: [{ role: "user"|"assistant", content: string }]
  chat:   (messages) => api.post("/ai/chat", { messages }).then(r => r.data),

  // Tool-using workflow agent. The backend runs a multi-turn tool-use
  // loop (Anthropic/OpenAI) over: get_current_graph, update_graph,
  // list_triggers, create_trigger, list_configs.
  //
  // Args:
  //   messages       — the chat history so far (same shape as `chat`)
  //   graphId        — id of the saved graph the editor is on (null for new)
  //   currentGraph   — the editor's working draft DSL (so the agent sees
  //                    unsaved edits via get_current_graph)
  //
  // Returns:
  //   {
  //     message:        { role: "assistant", content },
  //     proposedGraph?: <DSL object>           // present when the agent ran update_graph
  //     triggerCreated?: { id, name, type }    // present when create_trigger fired
  //     traces: [{ tool, input, summary }]     // ordered tool calls
  //   }
  agent: ({ messages, graphId = null, currentGraph = null }) =>
    api.post("/ai/agent/chat", { messages, graphId, currentGraph }).then(r => r.data),
};

export const Configs = {
  // [{ type, label, description, fields, freeform }]
  types:  () => api.get("/configs/types").then(r => r.data),
  // Lists secrets masked. Use update flow to rotate a secret.
  list:   () => api.get("/configs").then(r => r.data),
  get:    (id) => api.get(`/configs/${id}`).then(r => r.data),
  create: (payload) => api.post("/configs", payload).then(r => r.data),
  update: (id, patch) => api.put(`/configs/${id}`, patch).then(r => r.data),
  remove: (id) => api.delete(`/configs/${id}`).then(r => r.data),
};

export const Agents = {
  list:   () => api.get("/agents").then(r => r.data),
  get:    (id) => api.get(`/agents/${id}`).then(r => r.data),
  create: (payload) => api.post("/agents", payload).then(r => r.data),
  update: (id, patch) => api.put(`/agents/${id}`, patch).then(r => r.data),
  remove: (id) => api.delete(`/agents/${id}`).then(r => r.data),
};

export const Triggers = {
  list:   (graphId) => api.get("/triggers", graphId ? { params: { graphId } } : undefined).then(r => r.data),
  types:  () => api.get("/triggers/types").then(r => r.data),
  get:    (id) => api.get(`/triggers/${id}`).then(r => r.data),
  create: (data) => api.post("/triggers", data).then(r => r.data),
  update: (id, patch) => api.put(`/triggers/${id}`, patch).then(r => r.data),
  remove: (id) => api.delete(`/triggers/${id}`).then(r => r.data),
};

export function openLiveExecution(executionId, onMessage) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws?executionId=${executionId}`);
  ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch {} };
  return ws;
}
