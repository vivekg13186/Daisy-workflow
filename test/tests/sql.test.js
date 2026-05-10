// sql.* — exercises every SQL plugin against the test_database config
// (a Pagila / dvd_rental sample DB).
//
// Strategy:
//   - sql.select queries the read-only `actor` table that ships with the
//     dvd_rental sample. Stable enough to assert > 0 rows + a known column.
//   - sql.execute / sql.insert / sql.update / sql.delete operate on a
//     transient scratch table created in beforeAll and dropped in
//     afterAll, so the suite never mutates the demo data.

const { assertServerUp } = require("../helpers/client");
const {
  singleNodeGraph, createGraph, updateGraph, deleteGraph, runGraph,
  oneShot, uniqName, nodeOutput,
} = require("../helpers/graph");
const { CONFIGS } = require("../helpers/fixtures");

const SUITE_TAG = `dag_livetest_${Date.now()}`;
const TABLE     = `_${SUITE_TAG}`;            // schema-default search_path

describe("sql.*", () => {
  const graphIds = {};

  beforeAll(async () => {
    await assertServerUp();

    // Create the scratch table via a one-shot sql.execute graph. Same
    // shape that all five sql.* plugins now use: { config, sql, params }.
    await oneShot(singleNodeGraph({
      name: uniqName("sql-setup"), action: "sql.execute",
      nodeName: "setup",
      inputs: {
        config: CONFIGS.database,
        sql: `CREATE TABLE IF NOT EXISTS ${TABLE} (
                id     SERIAL PRIMARY KEY,
                name   TEXT   NOT NULL,
                value  INTEGER
              )`,
      },
    }), { expectStatus: "success" });

    // Build the per-plugin graphs. They all run as separate executions
    // so each test asserts against its own ctx.nodes entry.
    for (const [key, dsl] of Object.entries({
      select_dvd: singleNodeGraph({
        name: uniqName("sql-select-dvd"), action: "sql.select",
        nodeName: "selectActors",
        inputs: {
          config: CONFIGS.database,
          sql: "SELECT actor_id, first_name, last_name FROM actor ORDER BY actor_id LIMIT $1",
          params: [3],
        },
      }),
      insert: singleNodeGraph({
        name: uniqName("sql-insert"), action: "sql.insert",
        nodeName: "insertRow",
        inputs: {
          config: CONFIGS.database,
          sql: `INSERT INTO ${TABLE} (name, value) VALUES ($1, $2) RETURNING id, name, value`,
          params: ["alpha", 1],
        },
      }),
      select_scratch: singleNodeGraph({
        name: uniqName("sql-select-scratch"), action: "sql.select",
        nodeName: "selectScratch",
        inputs: {
          config: CONFIGS.database,
          sql: `SELECT id, name, value FROM ${TABLE} WHERE name = $1`,
          params: ["alpha"],
        },
      }),
      update: singleNodeGraph({
        name: uniqName("sql-update"), action: "sql.update",
        nodeName: "updateRow",
        inputs: {
          config: CONFIGS.database,
          sql: `UPDATE ${TABLE} SET value = $1 WHERE name = $2 RETURNING id, value`,
          params: [42, "alpha"],
        },
      }),
      delete: singleNodeGraph({
        name: uniqName("sql-delete"), action: "sql.delete",
        nodeName: "deleteRow",
        inputs: {
          config: CONFIGS.database,
          sql: `DELETE FROM ${TABLE} WHERE name = $1 RETURNING id`,
          params: ["alpha"],
        },
      }),
      execute_count: singleNodeGraph({
        name: uniqName("sql-execute"), action: "sql.execute",
        nodeName: "execCount",
        inputs: {
          config: CONFIGS.database,
          sql: `SELECT count(*)::int AS n FROM ${TABLE}`,
        },
      }),
    })) {
      const g = await createGraph(dsl);
      graphIds[key] = g.id;
      await updateGraph(g.id, dsl);
    }
  });

  afterAll(async () => {
    for (const id of Object.values(graphIds)) await deleteGraph(id);
    // Tear the scratch table down so re-runs start clean. Do this last
    // so a failure mid-suite doesn't leave it lingering.
    try {
      await oneShot(singleNodeGraph({
        name: uniqName("sql-teardown"), action: "sql.execute",
        nodeName: "teardown",
        inputs: {
          config: CONFIGS.database,
          sql: `DROP TABLE IF EXISTS ${TABLE}`,
        },
      }), { expectStatus: "success" });
    } catch { /* swallow — afterAll must not mask test failures */ }
  });

  test("sql.select against dvd_rental.actor returns rows", async () => {
    const exec = await runGraph(graphIds.select_dvd, { expectStatus: "success" });
    const out = nodeOutput(exec, "selectActors");
    expect(out.status).toBe("success");
    expect(out.output.rowCount).toBe(3);
    expect(out.output.rows[0]).toHaveProperty("first_name");
    expect(out.output.rows[0]).toHaveProperty("last_name");
  });

  test("sql.insert returns the new row when RETURNING is set", async () => {
    const exec = await runGraph(graphIds.insert, { expectStatus: "success" });
    const out = nodeOutput(exec, "insertRow");
    expect(out.status).toBe("success");
    expect(out.output.rowCount).toBe(1);
    expect(out.output.rows[0]).toMatchObject({ name: "alpha", value: 1 });
    expect(out.output.rows[0].id).toBeGreaterThan(0);
  });

  test("sql.select against the scratch table sees the inserted row", async () => {
    const exec = await runGraph(graphIds.select_scratch, { expectStatus: "success" });
    const out = nodeOutput(exec, "selectScratch");
    expect(out.status).toBe("success");
    expect(out.output.rowCount).toBe(1);
    expect(out.output.rows[0]).toMatchObject({ name: "alpha", value: 1 });
  });

  test("sql.update bumps the value and returns the affected row", async () => {
    const exec = await runGraph(graphIds.update, { expectStatus: "success" });
    const out = nodeOutput(exec, "updateRow");
    expect(out.status).toBe("success");
    expect(out.output.rowCount).toBe(1);
    expect(out.output.rows[0].value).toBe(42);
  });

  test("sql.execute can run an arbitrary aggregate", async () => {
    const exec = await runGraph(graphIds.execute_count, { expectStatus: "success" });
    const out = nodeOutput(exec, "execCount");
    expect(out.status).toBe("success");
    expect(out.output.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  test("sql.delete removes the row and returns its id", async () => {
    const exec = await runGraph(graphIds.delete, { expectStatus: "success" });
    const out = nodeOutput(exec, "deleteRow");
    expect(out.status).toBe("success");
    expect(out.output.rowCount).toBe(1);
    expect(out.output.rows[0].id).toBeGreaterThan(0);
  });
});
