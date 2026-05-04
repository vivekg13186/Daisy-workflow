import { stat } from "node:fs/promises";
import { resolveSafePath } from "../io/util.js";

export default {
  name: "file.stat",
  description: "Check whether a path exists and return its size / type / mtime. Never throws on ENOENT — returns exists:false instead.",
  inputSchema: {
    type: "object",
    required: ["path"],
    properties: { path: { type: "string" } },
  },
  outputSchema: {
    type: "object",
    required: ["path", "exists"],
    properties: {
      path:        { type: "string" },
      exists:      { type: "boolean" },
      isFile:      { type: "boolean" },
      isDirectory: { type: "boolean" },
      size:        { type: "integer" },
      mtime:       { type: "string" },
    },
  },
  async execute({ path: p }) {
    const abs = resolveSafePath(p);
    try {
      const st = await stat(abs);
      return {
        path: abs,
        exists: true,
        isFile: st.isFile(),
        isDirectory: st.isDirectory(),
        size: st.size,
        mtime: st.mtime.toISOString(),
      };
    } catch (e) {
      if (e.code === "ENOENT") return { path: abs, exists: false };
      throw e;
    }
  },
};
