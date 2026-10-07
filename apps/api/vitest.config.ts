import { defineConfig } from "vitest/config";

// The suites run several files at once against one database, on machines as small as a
// two-core CI runner. Vitest's default of 5 seconds per test was being hit by ordinary tests
// (a sign-up plus a bcrypt hash plus a few queries) whenever a neighbouring file was busy,
// which showed up as a different "failure" on each run. The assertions are unchanged; a test
// that hangs still fails, just later.
export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
