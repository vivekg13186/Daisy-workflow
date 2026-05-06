# sql.insert

This plugin allows for inserting one or multiple rows into a database table. It supports bulk inserts, conflict handling, and the ability to return specific columns from the newly created records.

## Prerequisites
* **Database Connection:** A valid URI for a PostgreSQL or compatible database.
* **Table Structure:** The target table must exist, and the keys in your `values` object must match the table column names.
* **Permissions:** The database user requires `INSERT` privileges.
* **Mock Service:** Use **Neon.tech**, **Supabase**, or a local Dockerized PostgreSQL instance for testing.

## Inputs
| Name | Description | Sample |
| :--- | :--- | :--- |
| `connectionString` | The database connection URI. | `postgres://user:pass@host:5432/db` |
| `query` | Raw SQL INSERT statement (overrides table/values). | `INSERT INTO users(name) VALUES($1)` |
| `params` | Parameters for the raw `query`. | `["John Doe"]` |
| `table` | The name of the table to insert into. | `customers` |
| `values` | An object (single row) or array of objects (bulk). | `[{"name": "Alice"}, {"name": "Bob"}]` |
| `returning` | Array of columns to return after insertion. | `["id", "created_at"]` |
| `onConflict` | Handling for unique constraint violations: `error` or `nothing`. | `nothing` |

## Outputs
| Name | Description | Sample |
| :--- | :--- | :--- |
| `rows` | The inserted rows (if `returning` was used). | `[{"id": 1}, {"id": 2}]` |
| `rowCount` | The total number of rows inserted. | `2` |

## Sample workflow
```yaml
name: register-new-users
description: |
  Performs a bulk insert of user data and logs the 
  generated IDs. It ignores duplicates using onConflict: nothing.

data:
  dbConn: "postgres://admin:secret@localhost:5432/app_db"
  newUsers:
    - { email: "test1@example.com", status: "active" }
    - { email: "test2@example.com", status: "pending" }

nodes:
  - name: insert_users
    action: sql.insert
    inputs:
      - connectionString: "${dbConn}"
      - table: "users"
      - values: "${newUsers}"
      - onConflict: "nothing"
      - returning: ["id", "email"]
    outputs:
      - rows: createdRecords
      - rowCount: totalInserted

  - name: log_summary
    action: log
    inputs:
      - message: "Inserted ${totalInserted} users. First ID: ${createdRecords[0].id}"

edges:
  - from: insert_users
    to: log_summary
```

## Expected output
If two rows are inserted successfully with a returning clause:
```json
{
  "rows": [
    { "id": 101, "email": "test1@example.com" },
    { "id": 102, "email": "test2@example.com" }
  ],
  "rowCount": 2
}
```

## Troubleshooting
* **Column Mismatch:** If passing an array of objects, the plugin uses the keys of the *first* object to determine columns. Ensure all objects in the array have the same keys.
* **Unique Constraint Violation:** If `onConflict` is set to `error` (default), the plugin will throw an error if you try to insert a duplicate key.
* **Empty Values:** Passing an empty array to `values` will trigger an error.

## Library
* `../sql/util.js` - Internal utility for safe identifier quoting and query execution.

## Reference
* [PostgreSQL INSERT Documentation](https://www.postgresql.org/docs/current/sql-insert.html)
* [PostgreSQL ON CONFLICT Clause](https://www.postgresql.org/docs/current/sql-insert.html#SQL-ON-CONFLICT)
