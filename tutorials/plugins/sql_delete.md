# sql.delete

This plugin removes rows from a database table. It provides a safety mechanism to prevent accidental data loss by requiring an explicit `unsafe` flag if attempting a deletion without a `WHERE` clause.

## Prerequisites
* **Database Access:** A valid connection string to a PostgreSQL or compatible SQL database.
* **Permissions:** The database user must have `DELETE` privileges on the target table.
* **Test Database:** You can use a free tier database from providers like **Supabase**, **Neon**, or **ElephantSQL** for testing.

## Inputs
| Name | Description | Sample |
| :--- | :--- | :--- |
| `connectionString` | The database connection URI. | `postgres://user:pass@localhost:5432/db` |
| `query` | Raw SQL delete query (overrides table/where). | `DELETE FROM users WHERE id = $1` |
| `params` | Positional parameters for the raw query. | `[123]` |
| `table` | The name of the table to delete from. | `orders` |
| `where` | An object defining the filter conditions. | `{"status": "cancelled"}` |
| `returning` | Array of columns to return after deletion. | `["id", "amount"]` |
| `unsafe` | Set to `true` to allow deleting all rows. | `false` |

## Outputs
| Name | Description | Sample |
| :--- | :--- | :--- |
| `rows` | The rows deleted (if `returning` was used). | `[{"id": 123}]` |
| `rowCount` | The total number of rows removed. | `5` |

## Sample workflow
```yaml
name: cleanup-old-sessions
description: |
  Deletes session records that are marked as 'expired'.
  Uses the returning clause to log which IDs were removed.

data:
  dbConn: "postgres://admin:secret@db.example.com:5432/main"

nodes:
  - name: delete_expired
    action: sql.delete
    inputs:
      - connectionString: "${dbConn}"
      - table: "sessions"
      - where:
          status: "expired"
      - returning: ["id"]
    outputs:
      - rowCount: deletedCount
      - rows: deletedItems

  - name: report_cleanup
    action: log
    inputs:
      - message: "Cleanup complete. Removed ${deletedCount} sessions."

edges:
  - from: delete_expired
    to: report_cleanup
```

## Expected output
Upon successful execution, the plugin returns the impact of the operation:
```json
{
  "rows": [
    { "id": 45 },
    { "id": 92 }
  ],
  "rowCount": 2
}
```

## Troubleshooting
* **"Refusing DELETE without WHERE":** This safety error occurs if your `where` object is empty. If you truly intend to wipe the table, add `unsafe: true` to your inputs.
* **Connection Error:** Verify that your `connectionString` is formatted correctly and that the database server allows connections from your current IP.
* **Syntax Error:** When using raw `query`, ensure your SQL syntax matches the database engine (e.g., PostgreSQL uses `$1`, `$2` for parameters).

## Library
* `../sql/util.js` - Internal utility for executing queries and building safe SQL strings.

## Reference
* [PostgreSQL DELETE Documentation](https://www.postgresql.org/docs/current/sql-delete.html)
* [SQL Injection Prevention (OWASP)](https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html)
