/**
 * Separate owner-admitted B7 phase. Source-only; no ordinary CI policy edit.
 * It deliberately does not inherit unit-test capability defaults.
 */
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

for (const key of [
  "BILLING_NATIVE_TARGET_RECEIPT", "BILLING_NATIVE_WORKER_HANDOFF", "BILLING_NATIVE_API_RESULT",
]) {
  if (!process.env[key]?.trim()) throw new Error("Explicit owner-issued B7 phase paths required");
}

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    globals: false,
    env: { TZ: "UTC", NODE_ENV: "production" },
    include: ["test/native/billing-api-rotation.native.ts"],
    exclude: ["node_modules", "dist"],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 30000,
    hookTimeout: 15000,
    teardownTimeout: 15000,
    retry: 0,
    coverage: { enabled: false },
  },
});
