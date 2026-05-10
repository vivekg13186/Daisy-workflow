// Bootstrap the first admin user (and the default workspace) on a
// fresh Daisy database.
//
// Usage:
//
//   node src/cli/createAdmin.js \
//     --email   admin@example.com \
//     --password '<long-random>'    \
//     [--workspace 'My Team']        # default: "Default"
//     [--name 'Vivek G.']            # display name, optional
//
// Or env-driven (set BOOTSTRAP_ADMIN_AUTOCREATE=true and the
// BOOTSTRAP_ADMIN_* env vars; the worker calls runIfRequested() on
// boot to seed the first admin automatically — handy for CI/CD).
//
// Idempotency:
//   • If the workspace doesn't exist, it's created.
//   • If a user with the given email already exists, the script no-ops
//     (does NOT change an existing admin's password). Use a separate
//     "reset password" flow for that.
//
// Safety:
//   • Refuses to run if a workspace AND any user already exist AND
//     no --force flag is passed — guards against accidentally adding
//     an unexpected admin to an established install.

import "dotenv/config";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { pool } from "../db/pool.js";
import { hash } from "../auth/passwords.js";

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "default";
}

async function ensureWorkspace(name) {
  const slug = slugify(name);
  const { rows } = await pool.query(
    "SELECT id, name FROM workspaces WHERE slug = $1",
    [slug],
  );
  if (rows.length) return rows[0];
  const id = crypto.randomUUID();
  await pool.query(
    "INSERT INTO workspaces (id, name, slug) VALUES ($1, $2, $3)",
    [id, name, slug],
  );
  return { id, name };
}

async function existingUserByEmail(email) {
  const { rows } = await pool.query(
    "SELECT id, email, role FROM users WHERE lower(email) = lower($1)",
    [email],
  );
  return rows[0] || null;
}

export async function createAdmin({
  email,
  password,
  workspaceName = "Default",
  displayName = null,
  force = false,
}) {
  if (!email)    throw new Error("createAdmin: email required");
  if (!password) throw new Error("createAdmin: password required");
  if (password.length < 8) {
    throw new Error("createAdmin: password must be at least 8 characters");
  }

  const existing = await existingUserByEmail(email);
  if (existing) {
    return { ok: true, action: "noop", reason: "user already exists",
             userId: existing.id };
  }

  if (!force) {
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM users");
    if (rows[0].n > 0) {
      throw new Error(
        "refusing to add a new admin: users already exist. " +
        "Pass --force to override (creates an additional admin in the workspace).",
      );
    }
  }

  const ws  = await ensureWorkspace(workspaceName);
  const id  = crypto.randomUUID();
  const ph  = await hash(password);
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role, workspace_id,
                        status, display_name)
     VALUES ($1, $2, $3, 'admin', $4, 'active', $5)`,
    [id, email, ph, ws.id, displayName],
  );
  // Also drop a workspace_members row so the user can be cleanly
  // listed alongside workspace teammates.
  await pool.query(
    `INSERT INTO workspace_members (user_id, workspace_id, role)
     VALUES ($1, $2, 'admin')
     ON CONFLICT (user_id, workspace_id) DO NOTHING`,
    [id, ws.id],
  );

  return {
    ok: true,
    action: "created",
    userId: id,
    workspaceId: ws.id,
    workspaceName: ws.name,
    email,
  };
}

/** Boot-time hook: if BOOTSTRAP_ADMIN_AUTOCREATE is set and the DB
 *  has no users, seed an admin from BOOTSTRAP_ADMIN_EMAIL +
 *  BOOTSTRAP_ADMIN_PASSWORD. The worker calls this on startup. */
export async function runIfRequested() {
  if (String(process.env.BOOTSTRAP_ADMIN_AUTOCREATE || "").toLowerCase() !== "true") {
    return null;
  }
  const email    = process.env.BOOTSTRAP_ADMIN_EMAIL;
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!email || !password) return null;
  try {
    const result = await createAdmin({
      email,
      password,
      workspaceName: process.env.BOOTSTRAP_WORKSPACE_NAME || "Default",
    });
    return result;
  } catch (e) {
    if (/refusing to add a new admin/i.test(e.message)) return null;
    throw e;
  }
}

// CLI entry point.
//
// fileURLToPath(import.meta.url) decodes the URL form (which has %20
// for spaces) back to the same filesystem path string Node puts in
// process.argv[1] (which keeps spaces literal). The naive
// `file://${process.argv[1]}` comparison breaks any time the project
// path contains a space — exactly what was happening here.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = parseArgs(process.argv);
  const opts = {
    email:         argv.email         || process.env.BOOTSTRAP_ADMIN_EMAIL,
    password:      argv.password      || process.env.BOOTSTRAP_ADMIN_PASSWORD,
    workspaceName: argv.workspace     || "Default",
    displayName:   argv.name          || null,
    force:         !!argv.force,
  };
  if (!opts.email || !opts.password) {
    console.error("Usage: node src/cli/createAdmin.js --email <e> --password <p> [--workspace <name>] [--name <display>] [--force]");
    process.exit(2);
  }
  createAdmin(opts)
    .then((res) => {
      console.log(JSON.stringify(res, null, 2));
      return pool.end();
    })
    .then(() => process.exit(0))
    .catch((e) => {
      console.error("createAdmin failed:", e.message);
      pool.end().finally(() => process.exit(1));
    });
}
