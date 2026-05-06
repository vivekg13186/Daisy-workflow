# sql.update

This plugin modifies existing rows in a database table. Similar to `sql.delete`, it includes a safety guard that prevents accidental global updates unless the `unsafe` flag is explicitly set to `true`.

## Prerequisites
* **Database Connection:** A valid URI for a PostgreSQL or compatible database.
* **Write Permissions:** The database user must have `UPDATE` privileges on the target table.
* **Mock setup:** You can use a free cloud database like **Neon.tech** or **Supabase**. Ensure you have data to update:
  `INSERT INTO users (name, status) VALUES ('John Doe', 'pending');`

## Inputs
| Name | Description | Sample |
| :--- | :--- | :--- |
| `connectionString` | The database connection URI. | `postgres://user:pass@host:5432/db` |
| `query` | Raw SQL UPDATE statement (overrides table/set). | `UPDATE users SET status = $1 WHERE id = $2` |
| `params` | Parameters for the raw `query`. | `["active", 123]` |
| `table` | The name of the table to update. | `users` |
| `set` | Object containing columns and their new values. | `{"status": "active", "updated_at": "now()"}` |
| `where` | Object defining which rows to update. | `{"id": 123}` |
| `returning` | Array of columns to return after the update. | `["id", "status"]` |
| `unsafe` | Set to `true` to allow updating all rows in the table. | `false` |

## Outputs
| Name | Description | Sample |
| :--- | :--- | :--- |
| `rows` | The updated rows (if `returning` was used). | `[{"id": 123, "status": "active"}]` |
| `rowCount` | The total number of rows modified. | `1` |

## Sample workflow
```yaml
name: activate-user-account
description: |
  Updates a user's status to 'active' based on their email.
  Returns the updated record to confirm the change.

data:
  dbConn: "postgres://admin:secret@localhost:5432/app_db"
  userEmail: "john.doe@example.com"

nodes:
  - name: update_status
    action: sql.update
    inputs:
      - connectionString: "${dbConn}"
      - table: "users"
      - set:
          status: "active"
          last_verified: "2026-05-06T12:00:00Z"
      - where:
          email: "${userEmail}"
      - returning: ["id", "status"]
    outputs:
      - rowCount: updatedCount

  - name: log_success
    action: log
    executeIf: "${updatedCount > 0}"
    inputs:
      - message: "Successfully activated ${updatedCount} account(s) for ${userEmail}."

edges:
  - from: update_status
    to: log_success
```

## Expected output
If a row is successfully updated:
```json
{
  "rows": [
    { "id": 123, "status": "active" }
  ],
  "rowCount": 1
}
```

## Troubleshooting
* **"Refusing UPDATE without WHERE":** By default, the plugin blocks updates that don't have a `where` clause to prevent wiping data. Use `unsafe: true` if you actually want to update every row.
* **Column Errors:** Ensure the keys in the `set` object match the column names in your database exactly (case-sensitive if quoted).
* **Empty Set:** Attempting to run an update with an empty `set` object will result in an error.

## Library
* `../sql/util.js` - Internal utility for safe identifier quoting and query execution.

## Reference
* [PostgreSQL UPDATE Documentation](https://www.postgresql.org/docs/current/sql-update.html)
* [Parameterized Queries in Node-Postgres](https://node-postgres.com/features/queries#parameterized-query)
