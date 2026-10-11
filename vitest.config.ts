import { defineConfig } from "vitest/config";

// Unit tests are plain Node: no Cloudflare plugin, no workerd. The D1-facing
// code is exercised against a recording fake (see test/ingest.test.ts) or the
// in-memory SQLite harness in test/sqlite.ts.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
