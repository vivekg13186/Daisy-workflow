# excel.write

This plugin creates Microsoft Excel (.xlsx) files from data. It supports both single-sheet and multi-sheet modes, automatic column inference, and the ability to format header rows with bold text.

## Prerequisites
* **Write Permissions:** The runner must have permission to write to the destination directory.
* **Data Format:** Input should be an array of objects (for keyed columns) or an array of arrays (for raw rows).
* **Directory Access:** If `mkdir` is set to `false`, the parent directory must exist or the plugin will fail.

## Inputs
| Name | Description | Sample |
| :--- | :--- | :--- |
| `path` | Destination path for the `.xlsx` file. | `./exports/report.xlsx` |
| `sheet` | Name for the single sheet (default: "Sheet1"). | `Summary` |
| `rows` | Data rows for single-sheet mode. | `[{"Name": "Alice", "Sales": 100}]` |
| `headers` | Optional explicit column order. | `["Name", "Sales"]` |
| `sheets` | Array of sheet objects (multi-sheet mode). | `[{"name": "S1", "rows": [...]}]` |
| `mkdir` | If `true`, creates missing parent folders. | `true` |

## Outputs
| Name | Description | Sample |
| :--- | :--- | :--- |
| `path` | The absolute path to the created file. | `/app/exports/report.xlsx` |
| `sheets` | Summary of sheets created and their row counts. | `[{"name": "Summary", "rowCount": 1}]` |

## Sample workflow
```yaml
name: export-multi-sheet-report
description: |
  Collects data and exports it into a two-sheet Excel 
  workbook (Sales and Inventory).

data:
  salesData: [{"Date": "2026-05-01", "Total": 500}]
  stockData: [{"Item": "Widget", "Qty": 20}]

nodes:
  - name: generate_excel
    action: excel.write
    inputs:
      - path: "./reports/MasterReport.xlsx"
      - mkdir: true
      - sheets:
          - name: "Sales"
            rows: "${data.salesData}"
          - name: "Inventory"
            rows: "${data.stockData}"
    outputs:
      - path: fullPath

  - name: log_result
    action: log
    inputs:
      - message: "Report generated at ${fullPath}"

edges:
  - from: generate_excel
    to: log_result
```

## Expected output
The plugin returns the path and a summary of the sheets written:
```json
{
  "path": "/home/user/project/reports/MasterReport.xlsx",
  "sheets": [
    { "name": "Sales", "rowCount": 1 },
    { "name": "Inventory", "rowCount": 1 }
  ]
}
```

## Troubleshooting
* **Column Inference:** For objects, the plugin collects all unique keys from all rows to build the header. For arrays of arrays, no header row is created unless explicitly provided.
* **Large Datasets:** Generating very large Excel files can be memory-intensive. For extremely large exports (100k+ rows), consider CSV instead.
* **File Locks:** Ensure the file is not open in another application (like Excel) while the plugin tries to write to it, as this may cause a permission error.

## Library
* `exceljs` - Used for generating and managing workbook structures.
* `node:fs/promises` - Native Node.js module for directory creation.

## Reference
* [ExcelJS Official Documentation](https://github.com/exceljs/exceljs)
* [Office Open XML Spreadsheet format](https://en.wikipedia.org/wiki/Office_Open_XML)
