// Shared model + (de)serialization for the redesigned FlowDesigner.
//
// The visual editor works on a normalized in-memory model:
//
//   {
//     name, description,
//     data:   { ... },                    // top-level constants
//     meta: {
//       prompt:    "...",                 // AI generation prompt
//       positions: { <nodeName>: { x, y } },                 // canvas layout
//     },
//     nodes: [{ name, action, description, inputs, outputs,
//                executeIf, retry, retryDelay, onError, batchOver }],
//     edges: [{ from, to }],
//   }
//
// `version` is intentionally NOT part of the authored model — it is managed
// server-side (auto-incremented per save). Legacy YAML that carries a
// `version` key is parsed without error but the value is dropped on
// re-serialization, so saved YAML never contains it.
//
// Node `inputs` / `outputs` are stored as objects internally and serialized
// back to the array form on output (matches the spec authoring style).

import yaml from "js-yaml";

export function emptyModel(name = "new-flow") {
  return {
    name,
    description: "",
    data: {},
    meta: { prompt: "", positions: {} },
    nodes: [
      {
        name: "hello",
        action: "log",
        description: "",
        inputs: { message: "hi" },
        outputs: {},
        executeIf: "",
        retry: 0,
        retryDelay: 0,
        onError: "terminate",
        batchOver: "",
      },
    ],
    edges: [],
  };
}

/** Parse YAML string → normalized model. Throws on yaml errors. */
export function parseYamlToModel(text) {
  const parsed = yaml.load(text || "") || {};
  return normalize(parsed);
}

/** Take any (parsed or raw) shape and produce the normalized in-memory model. */
export function normalize(parsed) {
  const meta = { prompt: "", positions: {}, ...(parsed.meta || {}) };
  return {
    name:        parsed.name || "untitled",
    description: parsed.description || "",
    data:        parsed.data || {},
    meta,
    nodes:       (parsed.nodes || []).map(normalizeNode),
    edges:       (parsed.edges || []).map(e => ({ from: e.from, to: e.to })),
  };
}

function normalizeNode(n) {
  return {
    name:        n.name || "",
    action:      n.action || "",
    description: n.description || "",
    inputs:      kvFromAny(n.inputs),
    outputs:     kvFromAny(n.outputs),
    executeIf:   n.executeIf || "",
    retry:       n.retry || 0,
    retryDelay:  n.retryDelay || 0,
    onError:     n.onError || "terminate",
    batchOver:   n.batchOver || "",
  };
}

/** Accept either object form { k: v } or array form [{ k: v }] and return a flat object. */
function kvFromAny(value) {
  if (!value) return {};
  if (Array.isArray(value)) {
    const out = {};
    for (const item of value) {
      if (item && typeof item === "object") Object.assign(out, item);
    }
    return out;
  }
  return { ...value };
}

/** Serialize the normalized model back to a YAML string. */
export function serializeModelToYaml(model) {
  // Build a clean object — drop empty-meta sections to keep YAML readable.
  // Note: `version` is intentionally not emitted. The server tracks versions
  // automatically; we don't want it round-tripping through user-visible YAML.
  const out = { name: model.name };
  if (model.description) out.description = model.description;

  // Flatten meta — drop sub-keys that have no content.
  const meta = {};
  if (model.meta?.prompt)  meta.prompt = model.meta.prompt;
  if (model.meta?.positions && Object.keys(model.meta.positions).length) {
    meta.positions = model.meta.positions;
  }
  if (Object.keys(meta).length) out.meta = meta;

  if (model.data && Object.keys(model.data).length) out.data = model.data;

  out.nodes = (model.nodes || []).map(serializeNode);
  if (model.edges?.length) out.edges = model.edges.map(e => ({ from: e.from, to: e.to }));

  return yaml.dump(out, { lineWidth: 100, noRefs: true });
}

function serializeNode(n) {
  const out = { name: n.name, action: n.action };
  if (n.description) out.description = n.description;
  if (n.inputs && Object.keys(n.inputs).length)
    out.inputs = Object.entries(n.inputs).map(([k, v]) => ({ [k]: v }));
  if (n.outputs && Object.keys(n.outputs).length)
    out.outputs = Object.entries(n.outputs).map(([k, v]) => ({ [k]: v }));
  if (n.executeIf)               out.executeIf  = n.executeIf;
  if (n.retry)                   out.retry      = n.retry;
  if (n.retryDelay)              out.retryDelay = n.retryDelay;
  if (n.onError && n.onError !== "terminate") out.onError = n.onError;
  if (n.batchOver)               out.batchOver  = n.batchOver;
  return out;
}

/** Generate a unique node name based on a prefix (action shortname). */
export function uniqueNodeName(model, prefix) {
  const taken = new Set((model.nodes || []).map(n => n.name));
  const base = (prefix || "node").split(".").pop().replace(/[^A-Za-z0-9_-]/g, "_") || "node";
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return base + "-" + Date.now();
}

/** Trigger a browser download of `text` as `filename`. */
export function downloadText(filename, text, mime = "text/yaml") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Read a single user-selected file as text. Returns a Promise<string>. */
export function pickFileAsText(accept = ".yaml,.yml,.txt") {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    };
    input.click();
  });
}
