# sql.select

This plugin executes SELECT queries against a PostgreSQL-compatible database. It offers the flexibility of running raw SQL queries with parameters or using a structured input format to safely build queries with filters, sorting, and pagination.

## Prerequisites
* **Database Connection:** A valid connection string (URI) to your database.
* **Read Permissions:** The database user must have `SELECT` privileges on the target table.
* **Mock setup:** Use a free cloud database like **Neon.tech** or **Supabase**. You can create a quick test table with:
  `CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT, active BOOLEAN);`

## Inputs
| Name | Description | Sample |
| :--- | :--- | :--- |
| `connectionString` | The database connection URI. | `postgres://user:pass@host:5432/db` |
| `query` | Raw SQL SELECT statement (overrides structured fields). | `SELECT * FROM users WHERE id = $1` |
| `params` | Positional parameters for the raw query. | `[42]` |
| `table` | Table name to query (required if `query` is absent). | `users` |
| `columns` | Array of column names to retrieve. | `["id", "email"]` |
| `where` | Object defining filter conditions. | `{"active": true}` |
| `orderBy` | Sorting criteria. | `created_at DESC` |
| `limit` | Maximum number of rows to return (Max 100,000). | `100` |
| `offset` | Number of rows to skip (for pagination). | `0` |

## Outputs
| Name | Description | Sample |
| :--- | :--- | :--- |
| `rows` | An array of objects representing the returned records. | `[{"id": 1, "name": "Alice"}]` |
| `rowCount` | The number of rows returned in the current result set. | `1` |

## Sample workflow
```yaml
name: fetch-active-customers
description: |
  Retrieves a paginated list of active customers sorted by 
  their last login date.

data:
  dbUrl: "postgres://readonly:password@db.example.com/prod"

nodes:
  - name: get_customers
    action: sql.select
    inputs:
      - connectionString: "${dbUrl}"
      - table: "customers"
      - columns: ["id", "name", "email"]
      - where:
          status: "active"
      - orderBy: "last_login DESC"
      - limit: 50
    outputs:
      - rows: customerList
      - rowCount: count

  - name: process_data
    action: log
    executeIf: "${count > 0}"
    inputs:
      - message: "Found ${count} active customers. Processing first record: ${customerList[0].name}"

edges:
  - from: get_customers
    to: process_data
```

## Expected output
The plugin returns an array of objects where each key corresponds to a column name:
```json
{
  "rows": [
    { "id": 10, "name": "Alice", "email": "alice@example.com" },
    { "id": 15, "name": "Bob", "email": "bob@example.com" }
  ],
  "rowCount": 2
}
```

## Troubleshooting
* **Missing Query/Table:** You must provide either a raw `query` or a `table` name. If both are missing, the execution will fail.
* **SQL Injection Safety:** When using structured inputs (`where`, `table`, etc.), the plugin uses `quoteIdent` and parameterized queries to prevent SQL injection. Avoid manual string concatenation in the `query` field.
* **Large Result Sets:** Be mindful of the `limit`. Fetching 100,000 rows might consume significant memory in your workflow runner.

## Library
* `../sql/util.js` - Internal utility for running queries and sanitizing SQL identifiers.

## Reference
* [PostgreSQL SELECT Documentation](https://www.postgresql.org/docs/current/sql-select.html)
* [PostgreSQL Data Types](https://www.postgresql.org/docs/current/datatype.html)
