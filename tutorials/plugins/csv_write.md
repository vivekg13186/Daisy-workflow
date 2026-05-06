# csv.write

This plugin serializes an array of objects or arrays into CSV format. It can either save the resulting data directly to a file on disk or return the generated string for use in subsequent workflow steps.

## Prerequisites
* **Write Permissions:** If providing a `path`, the runner must have permission to write to that directory.
* **Input Structure:** Data should be an array of objects (e.g., `[{"id": 1, "name": "Alice"}]`) or an array of arrays (e.g., `[[1, "Alice"]]`).
* **Directory Access:** If `mkdir` is set to `false`, the parent directory for the output file must already exist.

## Inputs
| Name | Description | Sample |
| :--- | :--- | :--- |
| `path` | Optional file path. If omitted, returns the CSV as text. | `./exports/data.csv` |
| `rows` | The data to be serialized. | `[{"a": 1, "b": 2}]` |
| `headers` | Explicit column order (array of strings). | `["id", "name", "email"]` |
| `delimiter` | Character to separate values. | `,` |
| `mkdir` | If `true`, creates missing parent folders. | `true` |
| `header` | Whether to include the header row in the output. | `true` |

## Outputs
| Name | Description | Sample |
| :--- | :--- | :--- |
| `path` | Absolute path to the created file (if path was provided). | `/app/exports/data.csv` |
| `text` | The generated CSV string (if path was omitted). | `"id,name\n1,Alice"` |
| `rowCount` | The number of rows processed. | `100` |

## Sample workflow
```yaml
name: export-db-to-csv
description: |
  Fetches users from a database and exports them to a CSV file
  in a specific directory.

nodes:
  - name: get_users
    action: sql.select
    inputs:
      - connectionString: "${data.dbUrl}"
      - table: "users"
    outputs:
      - rows: userRecords

  - name: write_csv
    action: csv.write
    inputs:
      - path: "./output/reports/users_export.csv"
      - rows: "${userRecords}"
      - mkdir: true
      - headers: ["id", "username", "email"]
    outputs:
      - path: finalPath
      - rowCount: totalSaved

  - name: notify
    action: log
    inputs:
      - message: "Exported ${totalSaved} users to ${finalPath}"

edges:
  - from: get_users
    to: write_csv
  - from: write_csv
    to: notify
```

## Expected output
If writing to a file:
```json
{
  "path": "/absolute/path/to/output/reports/users_export.csv",
  "rowCount": 50
}
```
If returning text (no path provided):
```json
{
  "text": "id,username,email\n1,jdoe,john@example.com\n",
  "rowCount": 1
}
```

## Troubleshooting
* **Invalid Rows Format:** Ensure `rows` is an array. If you pass a single object by mistake, the plugin will throw an error.
* **Column Inference:** If you don't provide `headers` and your `rows` are objects, the plugin infers columns from the keys of the first object. Ensure all objects have consistent keys.
* **Permission Denied:** Ensure the runner has write access to the destination path.

## Library
* `csv-stringify/sync` - Synchronous CSV serialization for Node.js.
* `node:fs/promises` - Native Node.js module for file operations.

## Reference
* [CSV-Stringify Documentation](https://csv.js.org/stringify/)
* [PostgreSQL to CSV Workflows](#)
