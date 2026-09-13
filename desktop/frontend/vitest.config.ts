import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const srcDir = fileURLToPath(new URL("./src", import.meta.url));

// Standalone vitest config: jsdom for DOM tests. Deliberately does not load the
// Wails vite plugin (dev-server bindings generation) so tests run offline.
export default defineConfig({
  resolve: {
    // Mirror vite.config.ts so "@/..." imports (shadcn components) resolve.
    alias: { "@": srcDir },
  },
  test: {
    environment: "jsdom",
    // Enabled for tests/shell.test.tsx, whose brief-mandated code relies on
    // global it/expect. Explicit imports elsewhere keep working.
    globals: true,
    setupFiles: ["tests/setup.ts"],
    // Coverage (M4 Task 9): v8 provider pinned via @vitest/coverage-v8@5.0.0
    // (peer = exact vitest@5.0.0). Scoped to the app code we own — features
    // and lib; tests, shadcn ui primitives and locales are excluded. No
    // thresholds yet: M4 records the baseline first (components ≥70% gate
    // assessed in the task report).
    coverage: {
      provider: "v8",
      include: ["src/features/**", "src/lib/**"],
      // Styles have nothing to instrument; keep them out of the report.
      exclude: ["src/**/*.css"],
      reporter: ["text", "html"],
    },
  },
});
