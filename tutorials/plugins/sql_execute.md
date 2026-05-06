# sql.execute

A flexible plugin for interacting with a SQL database. It allows for the execution of raw SQL queries, calling stored procedures, or retrieving data from table-valued functions.

## Prerequisites
* **Database Connection:** A valid URI for a PostgreSQL or compatible database.
* **Schema Setup:** Ensure any procedures or functions you intend to call are already defined in the database.
* **Permissions:** The database user must have `EXECUTE` permissions for routines and `SELECT` permissions for functions/tables.
* **Mock Service:** Use **Neon.tech** or **Supabase** for a quick, free cloud-hosted PostgreSQL instance.

## Inputs
| Name | Description | Sample |
| :--- | :--- | :--- |
| `connectionString` | The database connection URI. | `postgres://user:pass@host:5432/db` |
| `query` | Raw SQL statement to execute. | `SELECT * FROM users WHERE active = true` |
| `params` | Parameters for the raw `query`. | `["active"]` |
| `procedure` | Name of the stored procedure to `CALL`. | `process_monthly_billing` |
| `function` | Name of the function to `SELECT * FROM`. | `get_user_analytics` |
| `args` | Arguments for the `procedure` or `function`. | `[2024, "October"]` |

## Outputs
| Name | Description | Sample |
| :--- | :--- | :--- |
| `rows` | Array of objects representing the resulting rows. | `[{"id": 1, "val": "data"}]` |
| `rowCount` | Total number of rows affected or returned. | `1` |

## Sample workflow
```yaml
name: run-database-routine
description: |
  Calls a stored procedure to refresh a materialized view 
  and then fetches the latest summary data using a function.

data:
  dbConn: "${process.env.DATABASE_URL}"

nodes:
  - name: refresh_view
    action: sql.execute
    inputs:
      - connectionString: "${dbConn}"
      - procedure: "refresh_reports"
      - args: ["fast_mode"]

  - name: get_summary
    action: sql.execute
    inputs:
      - connectionString: "${dbConn}"
      - function: "get_daily_summary"
      - args: ["2026-05-06"]
    outputs:
      - rows: summaryData

  - name: log_summary
    action: log
    inputs:
      - message: "Summary for today: ${summaryData[0].total_count} items processed."

edges:
  - from: refresh_view
    to: get_summary
  - from: get_summary
    to: log_summary
```

## Expected output
For a function call or SELECT query:
```json
{
  "rows": [
    { "total_count": 450, "avg_value": 12.5 }
  ],
  "rowCount": 1
}
```

## Troubleshooting
* **Missing Input:** You must provide exactly one of `query`, `procedure`, or `function`. Providing none will result in an error.
* **Placeholder Mismatch:** The plugin automatically generates `$1, $2, ...` placeholders based on the `args` array. Ensure the number of arguments matches the database routine definition.
* **Undefined Routine:** If the procedure or function name is misspelled or in a different schema, the database will return a "routine does not exist" error.

## Library
* `../sql/util.js` - Internal database utility for query execution and identifier quoting.

## Reference
* [PostgreSQL CALL Documentation](https://www.postgresql.org/docs/current/sql-call.html)
* [PostgreSQL Function Documentation](https://www.postgresql.org/docs/current/functions.html)
