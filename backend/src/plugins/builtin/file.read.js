import { readFile, stat } from "node:fs/promises";
import { resolveSafePath } from "../io/util.js";

export default {
  name: "file.read",
  description: "Read a file from disk. Returns content as text (utf8/etc) or base64 for binary.",
  inputSchema: {
    type: "object",
    required: ["path"],
    properties: {
      path:     { type: "string" },
      encoding: { type: "string", enum: ["utf8", "utf-8", "ascii", "latin1", "base64"], default: "utf8" },
    },
  },
  outputSchema: {
    type: "object",
    required: ["content", "size", "path"],
    properties: {
      path:     { type: "string" },
      content:  { type: "string" },
      size:     { type: "integer" },
      encoding: { type: "string" },
    },
  },
  async execute({ path: p, encoding = "utf8" }) {
    const abs = resolveSafePath(p);
    const buf = await readFile(abs);
    const content = buf.toString(encoding);
    const st = await stat(abs);
    return { path: abs, content, size: st.size, encoding };
  },
};
