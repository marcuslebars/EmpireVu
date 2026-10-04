/**
 * fetch for Supabase clients that never uses Next's data cache.
 *
 * Next.js caches GET `fetch` calls made during a route handler unless the route is
 * provably dynamic. A public route that only uses the service-role client (e.g. the
 * /i/ invoice page, the /p/ portal) would otherwise get cached PostgREST answers
 * back — a paid invoice still showing "due", a revoked portal link still working.
 * Database reads must always be live, so every Supabase client opts out explicitly.
 * Outside Next (workers, jobs) `cache: "no-store"` is a harmless standard option.
 */
export const noStoreFetch: typeof fetch = (input, init) => fetch(input, { ...init, cache: "no-store" });
