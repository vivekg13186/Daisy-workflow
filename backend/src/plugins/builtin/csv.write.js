import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { stringify } from "csv-stringify/sync";
import { resolveSafePath } from "../io/util.js";

export default {
  name: "csv.write",
  description: "Serialize rows to CSV. Writes to `path` (returns the file path) or returns the generated text when `path` is omitted.",
  inputSchema: {
    type: "object",
    required: ["rows"],
    properties: {
      path:      { type: "string" },
      rows:      { type: "array" },                       // [{a:1,b:2}, ...] OR [[1,2], ...]
      headers:   { type: "array", items: { type: "string" } },  // explicit column order
      delimiter: { type: "string", default: "," },
      mkdir:     { type: "boolean", default: false },
      header:    { type: "boolean", default: true },      // whether to emit the header row
    },
  },
  outputSchema: {
    type: "object",
    required: ["rowCount"],
    properties: {
      path:     { type: "string" },
      text:     { type: "string" },
      rowCount: { type: "integer" },
    },
  },
  async execute({ path: p, rows, headers, delimiter = ",", mkdir: doMkdir = false, header = true }) {
    if (!Array.isArray(rows)) throw new Error("csv.write: rows must be an array");
    const text = stringify(rows, {
      header,
      columns: headers,             // if undefined and rows are objects, csv-stringify infers from keys
      delimiter,
    });
    if (!p) return { text, rowCount: rows.length };
    const abs = resolveSafePath(p);
    if (doMkdir) await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, text, "utf8");
    return { path: abs, rowCount: rows.length };
  },
};
