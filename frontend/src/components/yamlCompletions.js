// Heuristic YAML completion source for the DAG DSL.
//
// The completion is context-aware: it inspects the current line and (lightly)
// the surrounding text to decide what's appropriate. We avoid a full YAML
// parse on every keystroke — regex-based scans are good enough for the small
// docs the editor is typically working with and keep latency negligible.
//
// Sources covered:
//   • action: <CURSOR>             → registered plugin names
//   • from: / to: <CURSOR>         → node names declared above
//   • onError: <CURSOR>            → enum (continue | terminate)
//   • inputs: → <CURSOR>           → input fields from the chosen action's inputSchema
//   • outputs: → <CURSOR>          → output fields from the action's outputSchema
//   • ${ <CURSOR> }                → data keys + nodes.<name>.output references
//   • bare line at any indent      → schema keys for that level (top / node / edge)

import { snippetCompletion } from "@codemirror/autocomplete";

// ---- Schema constants ----
// Note: `version` intentionally omitted — the server auto-manages versions
// and the user-authored YAML doesn't carry one.
const TOP_KEYS  = ["name", "description", "data", "nodes", "edges"];
const NODE_KEYS = ["name", "action", "description", "inputs", "outputs",
                   "executeIf", "retry", "retryDelay", "onError", "batchOver"];
const EDGE_KEYS = ["from", "to"];
const ON_ERROR  = ["continue", "terminate"];

// Snippets for top-level keys with sensible scaffolding.
const TOP_SNIPPETS = {
  name:        "name: ${flow-name}",
  description: "description: ${what this flow does}",
  data:        "data:\n  ${key}: ${value}",
  nodes:       "nodes:\n  - name: ${nodeName}\n    action: ${log}\n    inputs:\n      message: \"hi\"",
  edges:       "edges:\n  - { from: ${from}, to: ${to} }",
};

const NODE_SNIPPETS = {
  name:       "name: ${nodeName}",
  action:     "action: ${log}",
  inputs:     "inputs:\n      ${key}: ${value}",
  outputs:    "outputs:\n      ${pluginField}: ${ctxVar}",
  executeIf:  'executeIf: "${${expr}}"',
  retry:      "retry: ${3}",
  retryDelay: 'retryDelay: "${500ms}"',
  onError:    "onError: ${terminate}",
  batchOver:  'batchOver: "${${arr}}"',
};

/**
 * Build the completion source. `getCtx` is a callback that returns
 *   { plugins: Array<{name, description, inputSchema, outputSchema}> }
 * so we can pick up live updates after the plugins list loads.
 */
export function makeYamlCompletions(getCtx) {
  return function yamlCompletion(context) {
    const { state, pos, explicit } = context;
    const line = state.doc.lineAt(pos);
    const lineText = line.text;
    const before = lineText.slice(0, pos - line.from);
    const docText = state.doc.toString();
    const { plugins = [] } = getCtx() || {};

    // 1. Inside a ${...} expression — suggest data keys + nodes.<name>.output
    const exprStart = before.lastIndexOf("${");
    if (exprStart !== -1 && before.slice(exprStart).indexOf("}") === -1) {
      const expr = before.slice(exprStart + 2);
      const start = pos - expr.length;
      return {
        from: start,
        options: expressionOptions(docText, expr),
        validFor: /^[\w.\[\]'-]*$/,
      };
    }

    // 2. action: <cursor> — plugin names
    let m = /^(\s*-?\s*)action:\s*(\S*)$/.exec(before);
    if (m) {
      const word = m[2];
      return {
        from: pos - word.length,
        options: plugins.map(p => ({
          label: p.name,
          info:  p.description || p.name,
          type:  "function",
        })),
        validFor: /^[\w.-]*$/,
      };
    }

    // 3. from: / to: <cursor> — node names
    m = /^(\s*-?\s*)(from|to):\s*(\S*)$/.exec(before);
    if (m) {
      const word = m[3];
      return {
        from: pos - word.length,
        options: extractNodeNames(docText).map(n => ({
          label: n, type: "variable",
        })),
        validFor: /^[\w.-]*$/,
      };
    }

    // 4. onError: <cursor> — enum
    m = /^(\s*-?\s*)onError:\s*(\S*)$/.exec(before);
    if (m) {
      const word = m[2];
      return {
        from: pos - word.length,
        options: ON_ERROR.map(v => ({ label: v, type: "constant" })),
      };
    }

    // 5. Inputs / outputs key under a node — suggest action's schema fields
    const blockKey = enclosingBlockKey(state, line);  // "inputs" | "outputs" | null
    if (blockKey === "inputs" || blockKey === "outputs") {
      const key = /^(\s*-?\s*)(\w*)$/.exec(before);
      if (key) {
        const word = key[2];
        const action = nodeActionAbove(state, line);
        const plugin = plugins.find(p => p.name === action);
        const schema = blockKey === "inputs" ? plugin?.inputSchema : plugin?.outputSchema;
        const props = schema?.properties ? Object.keys(schema.properties) : [];
        if (props.length || explicit) {
          return {
            from: pos - word.length,
            options: props.map(k => {
              const def = schema.properties[k];
              const required = (schema.required || []).includes(k);
              return snippetCompletion(`${k}: \${1}`, {
                label: k,
                detail: required ? "required" : (def?.type || ""),
                info: def?.description || (def?.type ? `type: ${def.type}` : ""),
                type: "property",
                boost: required ? 10 : 0,
              });
            }),
          };
        }
      }
    }

    // 6. Bare key at any indent — top-level / node-level / edge-level keys
    m = /^(\s*-?\s*)(\w*)$/.exec(before);
    if (m && (explicit || m[2].length > 0)) {
      const word = m[2];
      const ctx = inferLevel(state, line);
      let snippets;
      if      (ctx === "top")  snippets = TOP_KEYS .map(k => snip(k, TOP_SNIPPETS[k]));
      else if (ctx === "node") snippets = NODE_KEYS.map(k => snip(k, NODE_SNIPPETS[k]));
      else if (ctx === "edge") snippets = EDGE_KEYS.map(k => snip(k, `${k}: \${nodeName}`));
      else snippets = NODE_KEYS.map(k => snip(k, NODE_SNIPPETS[k]));
      return { from: pos - word.length, options: snippets };
    }

    return null;
  };
}

function snip(label, body) {
  return snippetCompletion(body || `${label}: \${1}`, { label, type: "property" });
}

// ---- helpers ----

/** Pull every  - name: foo  declaration. */
function extractNodeNames(text) {
  const names = [];
  const re = /^\s*-\s+name:\s*['"]?([A-Za-z_][\w.-]*)/gm;
  let m;
  while ((m = re.exec(text))) names.push(m[1]);
  return [...new Set(names)];
}

/** Pull keys directly under the top-level data: block. */
function extractDataKeys(text) {
  const lines = text.split("\n");
  const keys = [];
  let inData = false, dataIndent = -1;
  for (const raw of lines) {
    const m = /^(\s*)([A-Za-z_]\w*):/.exec(raw);
    if (!m) continue;
    if (m[2] === "data" && m[1].length === 0) { inData = true; dataIndent = -1; continue; }
    if (!inData) continue;
    if (dataIndent === -1) dataIndent = m[1].length;
    if (m[1].length === 0) { inData = false; continue; }      // left the block
    if (m[1].length === dataIndent) keys.push(m[2]);
  }
  return keys;
}

/** Build expression-mode options. */
function expressionOptions(docText, partial) {
  const seen = new Set();
  const opts = [];
  const push = (label, type, info) => {
    if (seen.has(label)) return;
    seen.add(label);
    opts.push({ label, type, info });
  };
  for (const k of extractDataKeys(docText))         push(k, "variable", "from data:");
  for (const n of extractNodeNames(docText))         push(`nodes.${n}.output`, "variable", `output of ${n}`);
  push("data", "namespace", "merged data block");
  push("nodes", "namespace", "completed nodes");
  push("item", "variable", "current batch item (inside batchOver)");
  push("index", "variable", "current batch index");
  if (!partial) return opts;
  const lc = partial.toLowerCase();
  return opts.filter(o => o.label.toLowerCase().includes(lc));
}

/** Find the enclosing block key (inputs / outputs / ...) for the current line. */
function enclosingBlockKey(state, line) {
  const indent = leadingSpaces(line.text);
  for (let n = line.number - 1; n >= 1; n--) {
    const t = state.doc.line(n).text;
    if (!t.trim()) continue;
    const ind = leadingSpaces(t);
    if (ind >= indent) continue;        // sibling or deeper
    const m = /^\s*(?:-\s+)?(\w+):\s*$/.exec(t);
    if (m) return m[1];
    return null;
  }
  return null;
}

/** Walk up to find the action: line of the enclosing node. */
function nodeActionAbove(state, line) {
  for (let n = line.number; n >= 1; n--) {
    const t = state.doc.line(n).text;
    const m = /^\s*(?:-\s+)?action:\s*['"]?([\w.-]+)/.exec(t);
    if (m) return m[1];
    // Stop if we hit a sibling node start (- name:) ABOVE the action — means
    // we're not inside that node anymore.
    if (n < line.number && /^\s*-\s+name:/.test(t)) return null;
  }
  return null;
}

/** "top" | "node" | "edge" — best-effort guess from leading whitespace + headers. */
function inferLevel(state, line) {
  if (leadingSpaces(line.text) === 0) return "top";
  for (let n = line.number - 1; n >= 1; n--) {
    const t = state.doc.line(n).text;
    if (!t.trim()) continue;
    if (/^edges:\s*$/.test(t)) return "edge";
    if (/^nodes:\s*$/.test(t)) return "node";
    if (/^\s*-\s+name:/.test(t) && leadingSpaces(t) < leadingSpaces(line.text)) return "node";
    if (/^\s*-\s+from:/.test(t) && leadingSpaces(t) < leadingSpaces(line.text)) return "edge";
  }
  return "node";
}

function leadingSpaces(s) {
  const m = /^(\s*)/.exec(s);
  return m ? m[1].length : 0;
}
