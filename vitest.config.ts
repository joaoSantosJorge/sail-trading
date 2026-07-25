import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Four suites boot PGlite + run all migrations in beforeEach; under
    // parallel start-up the first hook regularly blows the default 10s.
    hookTimeout: 30_000,
    env: {
      // Modules under test transitively import src/server/env.ts; give it a
      // syntactically valid URL. Tests never open a real network connection.
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
});
