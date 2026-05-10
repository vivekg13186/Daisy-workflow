/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  // Per-test default timeout. Polling an execution to completion can take a
  // few seconds (queue → worker → DB write); 30s leaves headroom without
  // letting a stuck test wedge the suite.
  testTimeout: 30_000,
  // Run tests sequentially. The suite hits a single live worker; running
  // tests in parallel would mean N workflows in flight at once and noisy
  // assertions. `--runInBand` in scripts also enforces this from the CLI.
  maxWorkers: 1,
  testMatch: ["<rootDir>/tests/**/*.test.js"],
  // Surface a useful summary on failure without the verbose dot rain.
  verbose: true,
};
