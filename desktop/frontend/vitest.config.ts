import { defineConfig } from "vitest/config";

// Standalone vitest config: jsdom for DOM tests. Deliberately does not load the
// Wails vite plugin (dev-server bindings generation) so tests run offline.
export default defineConfig({
  test: {
    environment: "jsdom",
  },
});
