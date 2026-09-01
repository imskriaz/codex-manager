import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    // Filesystem, Git, crypto, and child-process suites contend heavily when
    // Vitest uses every logical CPU on Windows. Bound concurrency so timeout
    // failures indicate a real hang instead of test-runner resource starvation.
    maxWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
});
