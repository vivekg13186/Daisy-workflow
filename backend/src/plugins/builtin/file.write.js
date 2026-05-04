import { writeFile, appendFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { resolveSafePath } from "../io/util.js";

export default {
  name: "file.write",
  description: "Write a file to disk. Modes: overwrite (default) or append. Set mkdir:true to create parent dirs.",
  inputSchema: {
    type: "object",
    required: ["path", "content"],
    properties: {
      path:     { type: "string" },
      content:  { type: "string" },
      encoding: { type: "string", enum: ["utf8", "utf-8", "ascii", "latin1", "base64"], default: "utf8" },
      mode:     { type: "string", enum: ["overwrite", "append"], default: "overwrite" },
      mkdir:    { type: "boolean", default: false },
    },
  },
  outputSchema: {
    type: "object",
    required: ["path", "size"],
    properties: {
      path: { type: "string" },
      size: { type: "integer" },
    },
  },
  async execute({ path: p, content, encoding = "utf8", mode = "overwrite", mkdir: doMkdir = false }) {
    const abs = resolveSafePath(p);
    if (doMkdir) await mkdir(path.dirname(abs), { recursive: true });
    const data = encoding === "base64" ? Buffer.from(content, "base64") : content;
    if (mode === "append") {
      await appendFile(abs, data, encoding === "base64" ? undefined : encoding);
    } else {
      await writeFile(abs, data, encoding === "base64" ? undefined : encoding);
    }
    const st = await stat(abs);
    return { path: abs, size: st.size };
  },
};
