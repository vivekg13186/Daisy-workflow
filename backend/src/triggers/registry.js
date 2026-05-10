// Trigger plugin registry. Same auto-discovery shape as the action plugin
// registry, but trigger plugins have a different interface:
//
//   {
//     type:         "schedule" | "mqtt" | "email" | <custom>,
//     description:  "...",
//     configSchema: {...JSON Schema...},
//     async subscribe(config, onFire) {
//       // Open subscription. Whenever the event happens, call onFire(payload).
//       return { stop: async () => { ...cleanup... } };
//     }
//   }

import Ajv from "ajv";
import addFormats from "ajv-formats";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { log } from "../utils/logger.js";

const ajv = new Ajv({ allErrors: true, coerceTypes: true, useDefaults: true, strict: false });
addFormats(ajv);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

class TriggerRegistry {
  constructor() { this.types = new Map(); }

  register(plugin) {
    if (!plugin?.type) throw new Error("Trigger plugin must export a `type`.");
    if (typeof plugin.subscribe !== "function") {
      throw new Error(`Trigger "${plugin.type}" missing async subscribe(config, onFire).`);
    }
    const validate = plugin.configSchema ? ajv.compile(plugin.configSchema) : null;
    this.types.set(plugin.type, { ...plugin, validateConfig: validate });
    log.info("trigger registered", { type: plugin.type });
  }

  get(type) {
    const p = this.types.get(type);
    if (!p) throw new Error(`Unknown trigger type "${type}"`);
    return p;
  }

  list() {
    return [...this.types.values()].map(t => ({
      type: t.type,
      description: t.description,
      configSchema: t.configSchema,
    }));
  }

  validateConfig(type, config) {
    const p = this.get(type);
    if (!p.validateConfig) return;
    if (!p.validateConfig(config)) {
      const errs = p.validateConfig.errors.map(e => `${e.instancePath} ${e.message}`).join("; ");
      throw new Error(`Trigger "${type}" config invalid: ${errs}`);
    }
  }

  async subscribe(type, config, onFire, ctx = {}) {
    const p = this.get(type);
    if (p.validateConfig && !p.validateConfig(config)) {
      const errs = p.validateConfig.errors.map(e => `${e.instancePath} ${e.message}`).join("; ");
      throw new Error(`Trigger "${type}" config invalid: ${errs}`);
    }
    // ctx is passed through to drivers as a third argument so they can
    // resolve workspace-scoped lookups (configs etc.). New drivers
    // accept (config, onFire, ctx); legacy two-arg drivers still work.
    return p.subscribe(config, onFire, ctx);
  }
}

export const triggerRegistry = new TriggerRegistry();

export async function loadTriggerBuiltins() {
  const dir = path.resolve(__dirname, "builtin");
  let files;
  try { files = await readdir(dir); }
  catch { return; }
  for (const f of files) {
    if (!f.endsWith(".js")) continue;
    const mod = await import(pathToFileURL(path.join(dir, f)).href);
    triggerRegistry.register(mod.default || mod.plugin);
  }
}
