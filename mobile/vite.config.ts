import path from "node:path";

import react from "@vitejs/plugin-react-swc";
import { defineConfig } from "vitest/config";

/**
 * The mobile app is its own bundle (served from the Capacitor shell), but it shares the
 * web app's data layer: `@/lib/api-client` resolves into the repo's src/, so request
 * shapes and response types never drift between web and mobile.
 */
export default defineConfig({
  plugins: [react()],
  // Plain CSS only — don't inherit the web app's Tailwind PostCSS config from the repo root.
  css: { postcss: {} },
  resolve: {
    alias: {
      "@m": path.resolve(__dirname, "src"),
      "@": path.resolve(__dirname, "../src"),
    },
    // Shared files resolve bare imports from the repo root; keep one copy of each runtime.
    dedupe: ["react", "react-dom", "@tanstack/react-query", "@supabase/supabase-js"],
  },
  server: { port: 5174, strictPort: true },
  // One bundle loaded from the device, not the network, so chunk size is not a latency concern.
  build: { outDir: "dist", sourcemap: false, target: ["es2020", "safari15", "chrome100"], chunkSizeWarningLimit: 1500 },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
