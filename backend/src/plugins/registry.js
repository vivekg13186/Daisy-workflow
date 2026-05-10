import Ajv from "ajv";
import addFormats from "ajv-formats";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { trace, SpanStatusCode } from "@opentelemetry/api";
import { log } from "../utils/logger.js";

const tracer = trace.getTracer("daisy-dag.plugins");

const ajv = new Ajv({ allErrors: true, coerceTypes: true, useDefaults: true, strict: false });
addFormats(ajv);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

class PluginRegistry {
  constructor() { this.plugins = new Map(); }

  register(plugin) {
    if (!plugin || typeof plugin !== "object" || !plugin.name) {
      throw new Error("Plugin must export an object with a 'name'.");
    }
    if (typeof plugin.execute !== "function") {
      throw new Error(`Plugin "${plugin.name}" missing async execute(input, ctx).`);
    }
    const validateInput  = plugin.inputSchema  ? ajv.compile(plugin.inputSchema)  : null;
    const validateOutput = plugin.outputSchema ? ajv.compile(plugin.outputSchema) : null;
    this.plugins.set(plugin.name, { ...plugin, validateInput, validateOutput });
    log.info("plugin registered", { name: plugin.name });
  }

  get(name) {
    const p = this.plugins.get(name);
    if (!p) throw new Error(`Unknown action "${name}"`);
    return p;
  }

  list() {
    return [...this.plugins.values()].map(p => ({
      name: p.name,
      description: p.description,
      inputSchema: p.inputSchema,
      outputSchema: p.outputSchema,
    }));
  }

  /**
   * Invoke a registered plugin.
   *
   *     async execute(input, ctx, hooks, opts) {
   *       hooks?.stream?.text("partial token");
   *       // opts.signal is an AbortSignal the engine cancels on
   *       // timeout. Pass it to fetch / pg / etc. for cooperative
   *       // cancellation. Plugins that ignore it still get killed at
   *       // the engine layer; honoring it just shortens the leak
   *       // window when the timer fires.
   *       return { ... };
   *     }
   *
   * Plugins that don't declare `opts` are unaffected — JS varargs
   * are lenient.
   *
   * Every invoke is wrapped in a `plugin.<name>` OTel span so external
   * calls (pg, fetch, redis, etc.) made by the plugin nest cleanly under
   * its own span. Plugins that want richer observability (e.g. agents
   * adding an llm.generate child span) can read `trace.getActiveSpan()`
   * inside `execute` — the span we open here is the parent.
   */
  async invoke(name, input, ctx, hooks, opts = {}) {
    return tracer.startActiveSpan(
      `plugin.${name}`,
      { attributes: { "plugin.name": name } },
      async (span) => {
        try {
          const p = this.get(name);
          if (p.validateInput && !p.validateInput(input)) {
            const errs = p.validateInput.errors.map(e => `${e.instancePath} ${e.message}`).join("; ");
            throw new Error(`Plugin "${name}" input invalid: ${errs}`);
          }
          const output = await p.execute(input, ctx, hooks, opts);
          if (p.validateOutput && !p.validateOutput(output)) {
            const errs = p.validateOutput.errors.map(e => `${e.instancePath} ${e.message}`).join("; ");
            throw new Error(`Plugin "${name}" output invalid: ${errs}`);
          }
          span.setStatus({ code: SpanStatusCode.OK });
          return output;
        } catch (e) {
          span.recordException(e);
          span.setStatus({ code: SpanStatusCode.ERROR, message: e?.message || String(e) });
          throw e;
        } finally {
          span.end();
        }
      },
    );
  }
}

export const registry = new PluginRegistry();

/** Auto-load every plugin file under src/plugins/builtin/ + plugins-extra/ */
export async function loadBuiltins() {
  const dirs = [
    path.resolve(__dirname, "builtin"),
    path.resolve(__dirname, "../../plugins-extra"),
  ];
  for (const dir of dirs) {
    let files;
    try { files = await readdir(dir); }
    catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".js")) continue;
      const mod = await import(pathToFileURL(path.join(dir, f)).href);
      registry.register(mod.default || mod.plugin);
    }
  }
}
