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
  },
});
