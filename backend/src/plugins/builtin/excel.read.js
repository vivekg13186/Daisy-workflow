import ExcelJS from "exceljs";
import { resolveSafePath } from "../io/util.js";

export default {
  name: "excel.read",
  description: "Read an .xlsx file. By default returns rows from the first sheet; pass `sheet` to pick another. With headers:true (default) returns array of objects keyed by the first row.",
  inputSchema: {
    type: "object",
    required: ["path"],
    properties: {
      path:    { type: "string" },
      sheet:   { type: "string" },                    // sheet name; default = first sheet
      headers: { type: "boolean", default: true },
      // Optional: read all sheets at once. Returns sheets[] instead of rows.
      allSheets: { type: "boolean", default: false },
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      path:     { type: "string" },
      sheet:    { type: "string" },
      columns:  { type: "array", items: { type: "string" } },
      rows:     { type: "array" },
      rowCount: { type: "integer" },
      sheets:   { type: "array" },     // when allSheets:true
    },
  },
  async execute({ path: p, sheet, headers = true, allSheets = false }) {
    const abs = resolveSafePath(p);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(abs);

    if (allSheets) {
      const sheets = wb.worksheets.map(ws => extractSheet(ws, headers));
      return { path: abs, sheets };
    }

    const ws = sheet ? wb.getWorksheet(sheet) : wb.worksheets[0];
    if (!ws) throw new Error(`excel.read: sheet "${sheet}" not found`);
    const out = extractSheet(ws, headers);
    return { path: abs, ...out };
  },
};

function extractSheet(ws, headers) {
  const all = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    // row.values is 1-indexed and has a leading undefined; slice it off.
    all.push(row.values.slice(1).map(cellValue));
  });

  if (headers && all.length) {
    const cols = all[0].map(v => v == null ? "" : String(v));
    const rows = all.slice(1).map(arr => {
      const o = {};
      cols.forEach((c, i) => { o[c || `col${i+1}`] = arr[i] ?? null; });
      return o;
    });
    return { sheet: ws.name, columns: cols, rows, rowCount: rows.length };
  }
  return { sheet: ws.name, columns: [], rows: all, rowCount: all.length };
}

// ExcelJS returns rich cell objects for hyperlinks / formulas / dates.
function cellValue(v) {
  if (v == null) return null;
  if (typeof v === "object") {
    if (v instanceof Date) return v.toISOString();
    if ("text" in v) return v.text;                 // hyperlink / rich text
    if ("result" in v) return v.result;             // formula
    if ("richText" in v) return v.richText.map(r => r.text).join("");
  }
  return v;
}
