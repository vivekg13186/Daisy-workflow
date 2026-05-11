// CLI: install an HTTP-transport plugin from its manifest endpoint.
//
//   node src/cli/installPlugin.js --endpoint http://reddit-plugin:8080
//   node src/cli/installPlugin.js --endpoint http://...:8080 --source marketplace:reddit-1.2.0
//
// Useful for first-time bootstrap and CI flows where you don't want
// to go through the admin UI. After installing, restart the worker
// (or POST /plugins/refresh as an admin) so the in-memory cache
// picks up the new row.

import "dotenv/config";
import { pool } from "../db/pool.js";
import { installFromEndpoint } from "../plugins/install.js";

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) { out[key] = true; }
    else                                  { out[key] = next; i++; }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.endpoint) {
    console.error("Usage: node src/cli/installPlugin.js --endpoint <url> [--source <provenance>]");
    process.exit(2);
  }
  const r = await installFromEndpoint({
    endpoint: args.endpoint,
    source:   args.source || "local",
  });
  console.log(JSON.stringify({ ok: true, plugin: r }, null, 2));
}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("installPlugin failed:", e.message);
    pool.end().finally(() => process.exit(1));
  });
