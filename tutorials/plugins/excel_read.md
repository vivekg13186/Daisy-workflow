# excel.read

This plugin extracts data from Microsoft Excel (.xlsx) files. It supports reading specific worksheets, parsing headers into object keys, and handling complex Excel cell types like formulas, hyperlinks, and dates.

## Prerequisites
* **File Access:** The runner must have read permissions for the target `.xlsx` file.
* **Format:** Only `.xlsx` files are supported (legacy `.xls` binary files are not compatible).
* **Mock setup:** Create a simple Excel file with at least one sheet. You can use tools like Google Sheets or LibreOffice to export a test `.xlsx` file.

## Inputs
| Name | Description | Sample |
| :--- | :--- | :--- |
| `path` | Path to the Excel file on disk. | `./imports/report.xlsx` |
| `sheet` | Name of the sheet to read. Defaults to the first sheet. | `Sales Data` |
| `headers` | If `true`, uses the first row as object keys. | `true` |
| `allSheets` | If `true`, returns data from every sheet in the workbook. | `false` |

## Outputs
| Name | Description | Sample |
| :--- | :--- | :--- |
| `path` | The absolute path to the file. | `/app/imports/report.xlsx` |
| `sheet` | The name of the sheet currently being read. | `Sheet1` |
| `columns` | List of detected column names (if headers=true). | `["ID", "Name", "Date"]` |
| `rows` | Array of records (Objects if headers=true, else Arrays). | `[{"ID": 1, "Name": "Product A"}]` |
| `rowCount` | Total number of records in the sheet. | `25` |
| `sheets` | Array of all sheet data (only if `allSheets` is true). | `[{"sheet": "S1", "rows": [...]}]` |

## Sample workflow
```yaml
name: process-monthly-excel
description: |
  Reads a specific sheet from a monthly report and logs 
  the number of entries found.

nodes:
  - name: read_excel
    action: excel.read
    inputs:
      - path: "./data/monthly_report.xlsx"
      - sheet: "Financials"
      - headers: true
    outputs:
      - rows: financeRows
      - rowCount: totalRecords

  - name: report_summary
    action: log
    inputs:
      - message: "Excel processing complete. ${totalRecords} rows imported from Financials sheet."

edges:
  - from: read_excel
    to: report_summary
```

## Expected output
When reading a single sheet with headers enabled:
```json
{
  "path": "/absolute/path/to/monthly_report.xlsx",
  "sheet": "Financials",
  "columns": ["TransactionID", "Amount", "Status"],
  "rows": [
    { "TransactionID": "TXN001", "Amount": 1500.50, "Status": "Paid" },
    { "TransactionID": "TXN002", "Amount": 200.00, "Status": "Pending" }
  ],
  "rowCount": 2
}
```

## Troubleshooting
* **Sheet Not Found:** If the `sheet` name provided doesn't exist in the workbook, the plugin will throw an error. Check for trailing spaces in sheet names.
* **Complex Cells:** This plugin automatically flattens Excel "Rich Text," Formulas, and Hyperlinks. Formulas return their last calculated `result`.
* **Date Formatting:** Dates are automatically converted to ISO strings (UTC) for consistent processing in the workflow.
* **Large Files:** Very large workbooks may consume significant memory. Consider splitting files if you encounter "Out of Memory" errors.

## Library
* `exceljs` - A professional workbook manager for reading, manipulating, and writing Excel spreadsheets.

## Reference
* [ExcelJS GitHub Documentation](https://github.com/exceljs/exceljs)
* [ISO 8601 Date Format](https://en.wikipedia.org/wiki/ISO_8601)
