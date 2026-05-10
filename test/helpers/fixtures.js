// Test fixtures used across multiple node test files.

const os = require("os");
const path = require("path");
const fs = require("fs");

/**
 * Build an absolute scratch path under the OS tmpdir. Set FILE_ROOT in
 * the backend .env to this same tmpdir if you've enabled FILE_ROOT
 * sandboxing — otherwise the file plugins resolve to absolute paths
 * directly and any temp directory is fine.
 */
function tmpPath(name) {
  const dir = process.env.TEST_TMP_DIR || path.join(os.tmpdir(), "dag-engine-livetest");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

/** Stable test config names. Tweak via env if your stored configs use different labels. */
const CONFIGS = {
  email:    process.env.CONFIG_EMAIL    || "test_send_email",
  database: process.env.CONFIG_DATABASE || "test_database",
  mqtt:     process.env.CONFIG_MQTT     || "test_mqtt",
};

/** A small URL the http.request + web.scrape tests can hit reliably. */
const HTTP_URL   = process.env.TEST_HTTP_URL   || "https://httpbin.org/get?probe=dag-engine";
const SCRAPE_URL = process.env.TEST_SCRAPE_URL || "https://example.com/";

module.exports = { tmpPath, CONFIGS, HTTP_URL, SCRAPE_URL };
