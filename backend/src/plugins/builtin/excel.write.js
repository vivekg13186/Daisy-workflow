import ExcelJS from "exceljs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { resolveSafePath } from "../io/util.js";

export default {
  name: "excel.write",
  description: "Write rows to an .xlsx file. Single-sheet (`sheet` + `rows` + optional `headers`) or multi-sheet (`sheets: [{name, rows, headers}]`).",
  inputSchema: {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string" },
      // Single-sheet mode
      sheet:   { type: "string", default: "Sheet1" },
      rows:    { type: "array" },                     // [{...}, ...] OR [[...], ...]
      headers: { type: "array", items: { type: "string" } },
      // Multi-sheet mode (overrides single-sheet props if present)
      sheets: {
        type: "array",
        items: {
          type: "object",
          required: ["name", "rows"],
          properties: {
            name:    { type: "string" },
            rows:    { type: "array" },
            headers: { type: "array", items: { type: "string" } },
          },
        },
      },
      mkdir: { type: "boolean", default: false },
    },
  },
  outputSchema: {
    type: "object",
    required: ["path", "sheets"],
    properties: {
      path:   { type: "string" },
      sheets: { type: "array" },
    },
  },
  async execute({ path: p, sheet = "Sheet1", rows, headers, sheets, mkdir: doMkdir = false }) {
    if (!Array.isArray(sheets)) {
      if (!Array.isArray(rows)) throw new Error("excel.write: provide `sheets[]` or single-sheet `rows[]`");
      sheets = [{ name: sheet, rows, headers }];
    }
    const abs = resolveSafePath(p);
    if (doMkdir) await mkdir(path.dirname(abs), { recursive: true });

    const wb = new ExcelJS.Workbook();
    const summary = [];
    for (const s of sheets) {
      const ws = wb.addWorksheet(s.name);
      const cols = inferColumns(s.rows, s.headers);
      if (cols.length) {
        ws.addRow(cols);
        ws.getRow(1).font = { bold: true };
      }
      for (const r of s.rows) {
        if (Array.isArray(r)) ws.addRow(r);
        else ws.addRow(cols.map(c => r?.[c] ?? null));
      }
      summary.push({ name: s.name, rowCount: s.rows.length });
    }
    await wb.xlsx.writeFile(abs);
    return { path: abs, sheets: summary };
  },
};

function inferColumns(rows, explicit) {
  if (explicit && explicit.length) return explicit;
  if (!rows.length) return [];
  if (Array.isArray(rows[0])) return [];     // arrays-of-arrays mode → no header row
  // Object mode: union of all keys preserving first-seen order.
  const seen = new Set(), cols = [];
  for (const r of rows) {
    if (r && typeof r === "object") {
      for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); cols.push(k); }
    }
  }
  return cols;
}
