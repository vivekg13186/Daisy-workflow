// audit/log.js tests — verifies the INSERT shape against a stubbed
// pool, plus the diff() helper.
//
// We don't run live SQL; that would require a real DB. Instead we
// install a module mock for ../src/db/pool.js (same pattern as
// retention.test.js) so we can capture the parameter array
// emitted by auditLog.

import { test, mock } from "node:test";
import assert from "node:assert/strict";

const calls = [];
mock.module("../src/db/pool.js", {
  namedExports: {
    pool: {
      async query(sql, params) {
        calls.push({ sql, params });
        return { rowCount: 1, rows: [] };
      },
    },
  },
});

const { auditLog, diff } = await import("../src/audit/log.js");

function reset() { calls.length = 0; }

test("auditLog: minimal call lands the canonical column order", async () => {
  reset();
  await auditLog({
    action: "user.create",
    actor:  { id: "u1", email: "vivek@example.com", role: "admin" },
    workspaceId: "ws1",
    resource: { type: "user", id: "u2", name: "new@example.com" },
    metadata: { role: "editor" },
  });
  assert.equal(calls.length, 1);
  const { sql, params } = calls[0];
  assert.match(sql, /INSERT INTO audit_logs/);
  // Param positions: id, workspace, actor_id, actor_email, actor_role,
  // action, resource_type, resource_id, resource_name,
  // outcome, metadata, ip, user_agent, trace_id
  // We pin most of them; id + trace_id are runtime-generated.
  assert.equal(params[1], "ws1");
  assert.equal(params[2], "u1");
  assert.equal(params[3], "vivek@example.com");
  assert.equal(params[4], "admin");
  assert.equal(params[5], "user.create");
  assert.equal(params[6], "user");
  assert.equal(params[7], "u2");
  assert.equal(params[8], "new@example.com");
  assert.equal(params[9], "success");
  assert.match(params[10], /"role":"editor"/);
});

test("auditLog: pulls actor + ip + ua from req.user / req", async () => {
  reset();
  const req = {
    user: { id: "u9", email: "u9@example.com", role: "editor", workspaceId: "wsX" },
    ip:   "203.0.113.42",
    headers: { "user-agent": "DaisyTest/1.0" },
  };
  await auditLog({ req, action: "graph.update", resource: { type: "graph", id: "g1" } });
  const { params } = calls[0];
  assert.equal(params[1], "wsX");                     // workspace_id from req.user
  assert.equal(params[2], "u9");                       // actor_id
  assert.equal(params[3], "u9@example.com");
  assert.equal(params[4], "editor");
  assert.equal(params[5], "graph.update");
  assert.equal(params[6], "graph");
  assert.equal(params[7], "g1");
  // ip is at index 11, user_agent at 12.
  assert.equal(params[11], "203.0.113.42");
  assert.equal(params[12], "DaisyTest/1.0");
});

test("auditLog: dropped on missing action (warn, no throw)", async () => {
  reset();
  await auditLog({ action: undefined });
  assert.equal(calls.length, 0);
});

test("auditLog: long resource_name is truncated to 250 chars", async () => {
  reset();
  await auditLog({
    action: "x.y",
    resource: { type: "graph", id: "g1", name: "x".repeat(500) },
  });
  assert.equal(calls[0].params[8].length, 250);
});

test("diff: emits only changed keys with from/to", () => {
  const d = diff(
    { role: "editor", status: "active",   name: "Same" },
    { role: "admin",  status: "active",   name: "Different" },
  );
  assert.deepEqual(d, {
    role: { from: "editor",  to: "admin"     },
    name: { from: "Same",    to: "Different" },
  });
});

test("diff: empty when nothing changed", () => {
  assert.deepEqual(diff({ a: 1 }, { a: 1 }), {});
});
