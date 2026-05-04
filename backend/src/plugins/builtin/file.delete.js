import { rm, stat } from "node:fs/promises";
import { resolveSafePath } from "../io/util.js";

export default {
  name: "file.delete",
  description: "Delete a file (or a directory when recursive:true). Refuses to remove a non-empty directory unless recursive:true.",
  inputSchema: {
    type: "object",
    required: ["path"],
    properties: {
      path:      { type: "string" },
      recursive: { type: "boolean", default: false },
      missingOk: { type: "boolean", default: false },     // don't throw if absent
    },
  },
  outputSchema: {
    type: "object",
    required: ["path", "deleted"],
    properties: {
      path:    { type: "string" },
      deleted: { type: "boolean" },
    },
  },
  async execute({ path: p, recursive = false, missingOk = false }) {
    const abs = resolveSafePath(p);
    let st;
    try { st = await stat(abs); }
    catch (e) {
      if (e.code === "ENOENT" && missingOk) return { path: abs, deleted: false };
      throw e;
    }
    if (st.isDirectory() && !recursive) {
      throw new Error(`file.delete: "${abs}" is a directory; pass recursive:true to remove`);
    }
    await rm(abs, { recursive, force: missingOk });
    return { path: abs, deleted: true };
  },
};
