// Fetch a URL and extract content using a list of CSS or XPath queries.
//
//   inputs:
//     url:        "https://example.com"
//     queries:
//       - { name: title,    type: css,   selector: "h1" }                 # text
//       - { name: links,    type: css,   selector: "a", attr: "href", all: true }
//       - { name: priceTxt, type: xpath, selector: "//*[@class='price']/text()" }
//       - { name: bodyHtml, type: css,   selector: "main", extract: html }
//
// Output:
//   { url, status, results: { <queryName>: value, ... } }

import { JSDOM } from "jsdom";

// XPathResult constants we use (kept inline so we don't depend on the
// JSDOM-instance constants — they're standard Web spec values).
const XPATH_ORDERED_NODE_SNAPSHOT_TYPE = 7;
const XPATH_STRING_TYPE = 2;
const XPATH_NUMBER_TYPE = 1;
const XPATH_BOOLEAN_TYPE = 3;
const XPATH_ANY_TYPE = 0;

export default {
  name: "web.scrape",
  description: "Download a URL's HTML and extract values using CSS or XPath queries. Returns a `results` object keyed by each query's `name`.",
  inputSchema: {
    type: "object",
    required: ["url", "queries"],
    // Keep this list scrape-shaped (URL + selectors first), not http-shaped.
    // method/body are intentionally NOT declared here — scrape is GET in
    // practice; the executor still honours them when set in JSON for
    // backward compatibility with older flows.
    properties: {
      url: {
        type: "string",
        format: "uri",
        title: "URL",
        description: "Page to fetch and parse.",
      },

      queries: {
        type: "array",
        minItems: 1,
        title: "Selectors",
        description:
          "One row per value to extract. Each row pairs a `name` (used as the " +
          "key in the results object) with a CSS or XPath selector.",
        items: {
          type: "object",
          required: ["name", "selector"],
          properties: {
            name:     { type: "string", minLength: 1 },
            type:     { type: "string", enum: ["css", "xpath"], default: "css" },
            selector: { type: "string", minLength: 1 },
            // What to pull from each matched node.
            //   text      - textContent (default), trimmed
            //   html      - innerHTML, trimmed
            //   outerHTML - outerHTML,  trimmed
            //   attr      - the attribute named by `attr` (or shorthand: set `attr` and omit `extract`)
            extract:  { type: "string", enum: ["text", "html", "outerHTML", "attr"] },
            attr:     { type: "string" },
            // If true, returns an array of all matches; otherwise the first match (or null).
            all:      { type: "boolean", default: false },
          },
        },
      },

      // ---- Power-user knobs below ----------------------------------------
      // Headers are useful for cookies / auth on protected pages. Edited as
      // a JSON object via the schema-driven property panel.
      headers: {
        type: "object",
        title: "Request headers",
        description: "Optional headers (e.g. Cookie, Authorization, User-Agent).",
        additionalProperties: { type: "string" },
      },
      timeoutMs: {
        type: "integer",
        title: "Timeout (ms)",
        minimum: 1, maximum: 60000, default: 15000,
        description: "Abort the fetch after this many milliseconds.",
      },
      baseUrl: {
        type: "string",
        format: "uri",
        title: "Base URL (override)",
        description:
          "Override the document baseURI used to resolve relative href/src " +
          "values. Defaults to the page URL itself.",
      },
    },
  },
  // What ctx[outputVar] receives when the node-level outputVar is set.
  primaryOutput: "results",

  outputSchema: {
    type: "object",
    required: ["status", "results"],
    properties: {
      url:     { type: "string" },
      status:  { type: "integer" },
      headers: { type: "object" },
      results: { type: "object" },
    },
  },

  async execute(input) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), input.timeoutMs || 15000);
    let res;
    try {
      res = await fetch(input.url, {
        method:  input.method || "GET",
        headers: { "user-agent": "DAG-Engine-Scraper/1.0", ...(input.headers || {}) },
        body:    input.body == null ? undefined
               : (typeof input.body === "string" ? input.body : JSON.stringify(input.body)),
        signal:  ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const html = await res.text();

    const dom = new JSDOM(html, { url: input.baseUrl || input.url });
    const doc = dom.window.document;

    const results = {};
    for (const q of input.queries) {
      try {
        results[q.name] = runQuery(doc, dom.window, q);
      } catch (e) {
        // Capture per-query errors instead of failing the whole node so one
        // bad selector doesn't lose the rest of the extraction.
        results[q.name] = { __error: e.message };
      }
    }

    return {
      url: input.url,
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      results,
    };
  },
};

function runQuery(doc, win, q) {
  const type = q.type || "css";

  if (type === "xpath") {
    // Best-effort detection: XPath expressions returning a non-node primitive
    // (count(), string(), boolean(), etc.) need a non-node result type.
    const isPrimitiveExpr = /^\s*(count|sum|number|string|boolean|name|local-name|namespace-uri|normalize-space|string-length)\s*\(/i.test(q.selector);

    if (isPrimitiveExpr) {
      const r = doc.evaluate(q.selector, doc, null, XPATH_ANY_TYPE, null);
      switch (r.resultType) {
        case XPATH_NUMBER_TYPE:  return r.numberValue;
        case XPATH_STRING_TYPE:  return r.stringValue;
        case XPATH_BOOLEAN_TYPE: return r.booleanValue;
        default: /* fall through to node handling */ break;
      }
    }

    const r = doc.evaluate(q.selector, doc, null, XPATH_ORDERED_NODE_SNAPSHOT_TYPE, null);
    const nodes = [];
    for (let i = 0; i < r.snapshotLength; i++) nodes.push(r.snapshotItem(i));
    return finalize(nodes.map(n => extractFrom(n, q, win)), q.all);
  }

  // CSS
  const matches = Array.from(doc.querySelectorAll(q.selector));
  return finalize(matches.map(n => extractFrom(n, q, win)), q.all);
}

function finalize(values, all) {
  if (all) return values;
  return values.length ? values[0] : null;
}

function extractFrom(node, q, win) {
  // Attribute extraction (either explicit `extract: attr` or just `attr` set).
  if (q.extract === "attr" || q.attr) {
    if (!q.attr) return null;
    if (typeof node.getAttribute === "function") return node.getAttribute(q.attr);
    // XPath can return Attr nodes directly (e.g. //a/@href)
    if (node && node.nodeType === win.Node.ATTRIBUTE_NODE) return node.value;
    return null;
  }
  switch (q.extract) {
    case "html":      return clean(node.innerHTML);
    case "outerHTML": return clean(node.outerHTML);
    case "text":
    default:
      // Element nodes: textContent. Text/Attr nodes (XPath): nodeValue.
      return clean(node.textContent ?? node.nodeValue);
  }
}

function clean(s) {
  if (s == null) return null;
  return String(s).trim();
}
