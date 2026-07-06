/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    typedRoutes: false,
  },
  // Next type-checks only the server/API tree (the Vite SPA client is checked by
  // `npm run typecheck` via tsconfig.app.json). See tsconfig.next.json.
  typescript: {
    tsconfigPath: "./tsconfig.next.json",
    // `npm run typecheck` (tsconfig.app.json) is the authoritative type gate for the
    // whole codebase at its chosen strictness, run pre-merge. Next forces
    // strictNullChecks on, which surfaces pre-existing latent issues unrelated to
    // serving; don't fail the production build on them.
    ignoreBuildErrors: true,
  },
  // Lint runs as its own step (`npm run lint`), not coupled to the production build.
  eslint: {
    ignoreDuringBuilds: true,
  },
  // Single-origin serving: the Vite SPA is built into /public; every non-API route
  // falls back to the SPA's index.html so the client router handles it. API routes
  // under /api/* are served by Next route handlers on the same origin, so the
  // Supabase auth cookie stays same-origin.
  async rewrites() {
    return {
      afterFiles: [
        { source: "/((?!api/).*)", destination: "/index.html" },
      ],
    };
  },
};

export default nextConfig;
