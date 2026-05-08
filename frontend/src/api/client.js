import axios from "axios";

const api = axios.create({ baseURL: "/api" });

export const Graphs = {
  list:     () => api.get("/graphs").then(r => r.data),
  get:      (id) => api.get(`/graphs/${id}`).then(r => r.data),
  create:   (yaml) => api.post("/graphs", { yaml }).then(r => r.data),
  update:   (id, yaml) => api.put(`/graphs/${id}`, { yaml }).then(r => r.data),
  remove:   (id) => api.delete(`/graphs/${id}`),
  validate: (yaml) => api.post("/graphs/validate", { yaml }).then(r => r.data),
  execute:  (id, context = {}) => api.post(`/graphs/${id}/execute`, { context }).then(r => r.data),
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
