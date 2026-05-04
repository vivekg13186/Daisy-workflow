import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { resolveSafePath, globToRegExp } from "../io/util.js";

export default {
  name: "file.list",
  description: "List entries in a directory. Optional `pattern` filters by basename (supports * and ?). `recursive` walks subdirectories.",
  inputSchema: {
    type: "object",
    required: ["path"],
    properties: {
      path:      { type: "string" },
      pattern:   { type: "string" },
      recursive: { type: "boolean", default: false },
      includeHidden: { type: "boolean", default: false },
    },
  },
  outputSchema: {
    type: "object",
    required: ["entries", "count"],
    properties: {
      entries: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name:        { type: "string" },
            path:        { type: "string" },
            isFile:      { type: "boolean" },
            isDirectory: { type: "boolean" },
            size:        { type: "integer" },
            mtime:       { type: "string" },
          },
        },
      },
      count: { type: "integer" },
    },
  },
  async execute({ path: p, pattern, recursive = false, includeHidden = false }) {
    const abs = resolveSafePath(p);
    const re = globToRegExp(pattern);
    const out = [];
    await walk(abs, recursive, includeHidden, re, out);
    return { entries: out, count: out.length };
  },
};

async function walk(dir, recursive, includeHidden, re, out) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch (e) { throw new Error(`file.list: ${e.message}`); }
  for (const ent of entries) {
    if (!includeHidden && ent.name.startsWith(".")) continue;
    const full = path.join(dir, ent.name);
    if (ent.isFile() || ent.isDirectory()) {
      if (!re || re.test(ent.name)) {
        let size = 0, mtime = null;
        try {
          const st = await stat(full);
          size = st.size; mtime = st.mtime.toISOString();
        } catch { /* race; skip */ }
        out.push({
          name: ent.name,
          path: full,
          isFile: ent.isFile(),
          isDirectory: ent.isDirectory(),
          size,
          mtime,
        });
      }
      if (recursive && ent.isDirectory()) {
        await walk(full, recursive, includeHidden, re, out);
      }
    }
  }
}
