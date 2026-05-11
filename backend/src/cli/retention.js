// CLI: one-off retention pass.
//
//   node src/cli/retention.js          # run every policy once
//   node src/cli/retention.js --dry    # NOT IMPLEMENTED — placeholder
//
// Useful when:
//   • You've just enabled retention on a DB with months of bloat
//     and want to chew through the backlog faster than the daily
//     schedule allows (just call the CLI repeatedly).
//   • You're verifying the windows are doing what you expect
//     before flipping RETENTION_ENABLED=true.
//
// Exits 0 on success even if individual policies failed — the JSON
// summary in stdout tells the operator what to dig into. Exit 1 is
// reserved for "couldn't even start" (DB unreachable, etc.).

import "dotenv/config";
import { pool } from "../db/pool.js";
import { runAll, getConfig } from "../retention/runner.js";

async function main() {
  // Force-run regardless of the RETENTION_ENABLED env so the CLI
  // is useful for one-off chores even when the schedule is off.
  const cfg = getConfig();
  process.stdout.write(JSON.stringify({
    ok: true, action: "starting", config: cfg,
  }, null, 2) + "\n");

  const result = await runAll();

  process.stdout.write(JSON.stringify({
    ok: true, action: "complete", result,
  }, null, 2) + "\n");
}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("retention CLI failed:", e.message);
    pool.end().finally(() => process.exit(1));
  });
