// Shared supertest agent + retry around a transient-fail HTTP request.
//
// Pointed at a live DAG-engine server (default http://localhost:3000); the
// API_BASE env var lets you override (e.g. for a Docker-Compose stack on
// a different port).
//
// All test files import `request()` rather than constructing supertest
// themselves so the base URL change in one place propagates everywhere.

const supertest = require("supertest");

const API_BASE = process.env.API_BASE || "http://localhost:3000";

function request() {
  return supertest(API_BASE);
}

/**
 * Fail fast with a descriptive error if the API isn't reachable. Test
 * files call this inside their `beforeAll` so a missing server produces
 * "API not reachable at http://localhost:3000" instead of an opaque
 * ECONNREFUSED in the middle of the suite.
 */
async function assertServerUp() {
  try {
    const res = await request().get("/plugins").timeout(2_000);
    if (res.status >= 500) {
      throw new Error(`API responded ${res.status} on /plugins`);
    }
  } catch (e) {
    throw new Error(
      `API not reachable at ${API_BASE} (${e.message}). ` +
      `Start the server (cd backend && npm run dev) and worker ` +
      `(cd backend && npm run worker) before running this suite, or set ` +
      `API_BASE to point elsewhere.`,
    );
  }
}

module.exports = { request, assertServerUp, API_BASE };
