import { defineStore } from "pinia";
import { Graphs, Executions, openLiveExecution } from "../api/client.js";

const SAMPLE_YAML = `name: hello-world
version: "1.0"
data:
  who: "world"

nodes:
  - name: greet
    action: log
    inputs:
      - message: "Hello, \${who}!"

  - name: pause
    action: delay
    inputs:
      - ms: 200

  - name: done
    action: log
    inputs:
      - message: "finished"

edges:
  - { from: greet, to: pause }
  - { from: pause, to: done }
`;

// Tab shapes:
//   { kind: "graph",     id: "graph:<id>"|"graph:new:<n>", graphId, name, version, yaml, parsed, dirty, validationError, executions }
//   { kind: "execution", id: "exec:<execId>",              execId, graphId, data, liveSocket, liveEvents[], nodeStatus{} }
let _newCounter = 0;

export const useGraphsStore = defineStore("graphs", {
  state: () => ({
    graphs: [],
    tabs: [],            // open editors / result viewers
    activeId: null,
  }),
  getters: {
    activeTab: (s) => s.tabs.find(t => t.id === s.activeId) || null,
    activeGraphTab: (s) => {
      const t = s.tabs.find(t => t.id === s.activeId);
      return t && t.kind === "graph" ? t : null;
    },
    activeExecTab: (s) => {
      const t = s.tabs.find(t => t.id === s.activeId);
      return t && t.kind === "execution" ? t : null;
    },
  },
  actions: {
    // ----- Graph list -----
    async loadGraphs() {
      this.graphs = await Graphs.list();
    },

    /**
     * Refresh the executions list for whichever graph the user is currently
     * looking at (the active editor tab, or the parent of the active execution
     * tab). Called periodically from the left pane.
     */
    async refreshActiveGraphExecutions() {
      const t = this.activeTab;
      const graphId = t?.kind === "graph" ? t.graphId
                    : t?.kind === "execution" ? t.graphId
                    : null;
      if (!graphId) return;
      const editor = this.tabs.find(x => x.kind === "graph" && x.graphId === graphId);
      if (!editor) return;
      try { editor.executions = await Executions.list(graphId); }
      catch { /* swallow polling errors */ }
    },

    // ----- Tabs -----
    activate(tabId) { this.activeId = tabId; },

    closeTab(tabId) {
      const t = this.tabs.find(x => x.id === tabId);
      if (!t) return;
      if (t.liveSocket) try { t.liveSocket.close(); } catch {}
      this.tabs = this.tabs.filter(x => x.id !== tabId);
      if (this.activeId === tabId) this.activeId = this.tabs[this.tabs.length - 1]?.id || null;
    },

    // ----- Open a graph in an editor tab -----
    async openGraph(id) {
      const tabId = `graph:${id}`;
      const existing = this.tabs.find(t => t.id === tabId);
      if (existing) { this.activeId = tabId; return; }
      const g = await Graphs.get(id);
      const executions = await Executions.list(id);
      this.tabs.push({
        kind: "graph", id: tabId,
        graphId: id, name: g.name, version: g.version,
        yaml: g.yaml, parsed: g.parsed, dirty: false,
        validationError: null,
        executions,
      });
      this.activeId = tabId;
    },

    openNewGraph() {
      _newCounter++;
      const tabId = `graph:new:${_newCounter}`;
      this.tabs.push({
        kind: "graph", id: tabId,
        graphId: null, name: `untitled-${_newCounter}`, version: null,
        yaml: SAMPLE_YAML, parsed: null, dirty: true,
        validationError: null,
        executions: [],
      });
      this.activeId = tabId;
    },

    setYaml(tabId, yaml) {
      const t = this.tabs.find(x => x.id === tabId);
      if (!t || t.kind !== "graph") return;
      if (t.yaml === yaml) return;
      t.yaml = yaml;
      t.dirty = true;
    },

    // ----- Validate / Save / Run -----
    async validate(tabId = this.activeId) {
      const t = this.tabs.find(x => x.id === tabId);
      if (!t || t.kind !== "graph") return false;
      try {
        const r = await Graphs.validate(t.yaml);
        t.parsed = r.parsed;
        t.validationError = null;
        return true;
      } catch (e) {
        t.parsed = null;
        t.validationError = formatError(e);
        return false;
      }
    },

    async save(tabId = this.activeId) {
      const t = this.tabs.find(x => x.id === tabId);
      if (!t || t.kind !== "graph") return;
      if (!await this.validate(tabId)) return;
      let saved;
      if (t.graphId) saved = await Graphs.update(t.graphId, t.yaml);
      else           saved = await Graphs.create(t.yaml);
      t.graphId = saved.id;
      t.name = saved.name;
      t.version = saved.version;
      t.id = `graph:${saved.id}`;
      this.activeId = t.id;
      t.dirty = false;
      t.executions = await Executions.list(saved.id);
      await this.loadGraphs();
    },

    async run(input = {}, tabId = this.activeId) {
      const t = this.tabs.find(x => x.id === tabId);
      if (!t || t.kind !== "graph") return null;
      if (t.dirty || !t.graphId) await this.save(tabId);
      const { executionId } = await Graphs.execute(t.graphId, input);
      // Refresh history list
      t.executions = await Executions.list(t.graphId);
      // Open the execution as its own tab so the user can navigate to it.
      this.openExecution(executionId, t.graphId, /*live=*/ true);
      return executionId;
    },

    // ----- Execution result tab -----
    async openExecution(execId, graphId = null, live = false) {
      const tabId = `exec:${execId}`;
      let t = this.tabs.find(x => x.id === tabId);
      if (!t) {
        t = {
          kind: "execution", id: tabId,
          execId, graphId, data: null,
          graphParsed: null,    // parent graph's parsed DSL (for the viewer)
          liveSocket: null, liveEvents: [], nodeStatus: {},
        };
        this.tabs.push(t);
      }
      this.activeId = tabId;

      // Fetch persisted snapshot.
      try { t.data = await Executions.get(execId); }
      catch { /* not persisted yet */ }
      // REPLACE nodeStatus (don't merge) so stale entries from a previous
      // load can't survive into the new render.
      t.nodeStatus = nodeStatusFromData(t.data);

      // Make sure we have the parent graph's parsed DSL so the viewer can render
      // the full DAG (with edges), even if the user never opened the editor tab.
      const gid = t.graphId || t.data?.graph_id;
      if (gid && !t.graphParsed) {
        const editor = this.tabs.find(x => x.kind === "graph" && x.graphId === gid);
        if (editor?.parsed) {
          t.graphParsed = editor.parsed;
        } else {
          try {
            const g = await Graphs.get(gid);
            t.graphParsed = g.parsed;
            t.graphId = gid;
          } catch { /* graph might be deleted */ }
        }
      }

      if (live) {
        if (t.liveSocket) try { t.liveSocket.close(); } catch {}
        t.liveSocket = openLiveExecution(execId, async (evt) => {
          t.liveEvents.unshift(evt);
          if (evt.type === "node:status") t.nodeStatus[evt.node] = evt.status;
          if (evt.type === "execution:end") {
            // Re-pull the persisted snapshot AND re-seed nodeStatus so any
            // status updates that the WS missed (or arrived out of order) get
            // reconciled from the source of truth.
            try {
              t.data = await Executions.get(execId);
              t.nodeStatus = nodeStatusFromData(t.data);
            } catch {}
          }
        });
      }
    },

    /**
     * Permanently delete a graph (current version only — older versions stay).
     * Closes any open editor or execution tab pointing at it, then refreshes
     * the flows list. Returns true on success.
     */
    async deleteGraph(graphId) {
      try {
        await Graphs.remove(graphId);
      } catch (e) {
        console.warn("deleteGraph failed", e);
        return false;
      }
      // Close any tabs that reference this graph (editor + any execution tabs).
      const toClose = this.tabs.filter(t =>
        (t.kind === "graph" && t.graphId === graphId) ||
        (t.kind === "execution" && t.graphId === graphId)
      );
      for (const t of toClose) this.closeTab(t.id);
      // Refresh top-level lists.
      await this.loadGraphs();
      return true;
    },

    /**
     * Permanently delete an execution and its node_logs.
     * Closes the matching tab if open, then refreshes the parent graph's
     * execution list (so the left-pane table updates).
     */
    async deleteExecution(execId) {
      // Locate parent graph id BEFORE we close the tab, so we can refresh.
      const tab = this.tabs.find(t => t.kind === "execution" && t.execId === execId);
      const graphId = tab?.graphId;
      try {
        await Executions.remove(execId);
      } catch (e) {
        console.warn("deleteExecution failed", e);
        return false;
      }
      if (tab) this.closeTab(tab.id);
      if (graphId) {
        const editor = this.tabs.find(t => t.kind === "graph" && t.graphId === graphId);
        if (editor) {
          try { editor.executions = await Executions.list(graphId); } catch {}
        }
      }
      return true;
    },

    /**
     * Re-fetch the active execution tab's row + node logs from the API.
     * Bound to the Refresh button in ExecutionView.
     */
    async refreshExecution(tabId = this.activeId) {
      const t = this.tabs.find(x => x.id === tabId);
      if (!t || t.kind !== "execution") return;
      try {
        const data = await Executions.get(t.execId);
        t.data = data;
        t.nodeStatus = nodeStatusFromData(data);
      } catch (e) {
        console.warn("refreshExecution failed", e);
      }
    },
  },
});

function formatError(e) {
  const data = e?.response?.data;
  if (!data) return e.message;
  const details = (data.details || []).map(d => ` • ${d.path || ""} ${d.message || ""}`).join("\n");
  return `${data.message}${details ? "\n" + details : ""}`;
}

/**
 * Build the { nodeName -> status } map used to color the GraphView, sourcing
 * from execution.context.nodes. For batch executions the per-item ctx lives
 * under context.items[i].nodes — we OR them together so a node shows the
 * "worst" status across items (failed > running > skipped > success).
 */
function nodeStatusFromData(data) {
  if (!data?.context) return {};
  const ctx = data.context;
  if (Array.isArray(ctx.items)) {
    const merged = {};
    const rank = { failed: 4, running: 3, retrying: 3, skipped: 2, pending: 1, success: 0 };
    for (const item of ctx.items) {
      const ns = item?.ctx?.nodes || item?.nodes || {};
      for (const [name, n] of Object.entries(ns)) {
        const s = n?.status;
        if (!s) continue;
        if (!merged[name] || (rank[s] || 0) > (rank[merged[name]] || 0)) merged[name] = s;
      }
    }
    return merged;
  }
  const out = {};
  for (const [name, n] of Object.entries(ctx.nodes || {})) out[name] = n?.status || "pending";
  return out;
}
