# csv.read

This plugin parses CSV data from either a local file or a raw string input. It can automatically detect headers to return objects or provide raw arrays, and it handles type casting for numbers and booleans.

## Prerequisites
* **File Access:** If reading from a path, the runner must have read permissions for the target file.
* **Format:** Ensure the file is a valid delimited text file (CSV, TSV, etc.).
* **Mock Data:** You can test with a simple string input: `id,name\n1,Alice\n2,Bob`

## Inputs
| Name | Description | Sample |
| :--- | :--- | :--- |
| `path` | Path to the CSV file on disk. | `./data/users.csv` |
| `text` | Raw CSV text content (overrides `path`). | `name,age\nJohn,30` |
| `delimiter` | Character used to separate values. | `,` |
| `headers` | If `true`, the first row is used as keys for objects. | `true` |
| `skipEmpty` | Skips lines that contain no data. | `true` |
| `cast` | Automatically converts numeric and boolean strings. | `true` |

## Outputs
| Name | Description | Sample |
| :--- | :--- | :--- |
| `path` | The absolute path to the file (if provided). | `/app/data/users.csv` |
| `rows` | Array of records (Objects if headers=true, else Arrays). | `[{"id": 1, "name": "Alice"}]` |
| `rowCount` | Total number of records parsed. | `150` |
| `columns` | List of detected column names. | `["id", "name"]` |

## Sample workflow
```yaml
name: process-inventory-csv
description: |
  Reads an inventory CSV file and logs the total number 
  of items found.

nodes:
  - name: read_inventory
    action: csv.read
    inputs:
      - path: "./imports/inventory.csv"
      - headers: true
      - cast: true
    outputs:
      - rows: items
      - rowCount: totalItems

  - name: summarize
    action: log
    inputs:
      - message: "CSV Load Complete. Found ${totalItems} items. Top item: ${items[0].productName}"

edges:
  - from: read_inventory
    to: summarize
```

## Expected output
When `headers: true` is used, each row becomes an object:
```json
{
  "path": "/absolute/path/to/imports/inventory.csv",
  "rowCount": 2,
  "columns": ["id", "productName", "stock"],
  "rows": [
    { "id": 1, "productName": "Widget A", "stock": 50 },
    { "id": 2, "productName": "Widget B", "stock": 12 }
  ]
}
```

## Troubleshooting
* **File Not Found:** Ensure the `path` is correct relative to the runner's working directory.
* **Delimiter Mismatch:** If your data uses semicolons (`;`) or tabs (`\t`), set the `delimiter` input explicitly.
* **Malformed Quotes:** If the CSV contains unclosed quotes, the parser might fail. The `relax_quotes` option is enabled by default to mitigate common formatting issues.

## Library
* `csv-parse/sync` - A powerful, synchronous CSV parsing library for Node.js.
* `node:fs/promises` - Native Node.js module for file system operations.

## Reference
* [CSV-Parse Documentation](https://csv.js.org/parse/)
* [RFC 4180 (CSV Standard)](https://datatracker.ietf.org/doc/html/rfc4180)
