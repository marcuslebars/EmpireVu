import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

import { platformBrandHtmlEnv, resolvePlatformBrand } from "./src/lib/platform-brand-core";

/**
 * index.html uses Vite's native `%VITE_PLATFORM_*%` substitution for the product name,
 * tagline and favicon. Vite leaves an UNSET placeholder in the HTML literally, so resolve
 * the platform brand here (env value if valid, else the CrankLeads default) and publish
 * the resolved values to process.env — which Vite's env loading reads with the highest
 * priority — before it loads env. See docs/branding.md.
 */
function seedPlatformBrandHtmlEnv(mode: string): void {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const brand = resolvePlatformBrand((key) => env[`VITE_${key}`]);
  for (const [key, value] of Object.entries(platformBrandHtmlEnv(brand))) {
    process.env[key] = value;
  }
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  seedPlatformBrandHtmlEnv(mode);
  return {
    server: {
      host: "::",
      port: 8080,
      hmr: {
        overlay: false,
      },
      proxy: {
        "/api": {
          changeOrigin: true,
          target: process.env.VITE_NEXT_SERVER_ORIGIN ?? "http://localhost:3000",
        },
      },
    },
    plugins: [react()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
  };
});
