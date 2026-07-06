import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * Session-refresh middleware only.
 *
 * It keeps the Supabase auth cookie fresh and does NOT redirect. Route protection is
 * enforced server-side by each API route (`requireOrganizationContext` -> 401/403,
 * `getAuthenticatedUser` -> 401) and, for UX only, by the SPA's client-side
 * `ProtectedRoute`. The client guard is cosmetic — the real boundary is the API layer,
 * covered by src/test/auth-boundary.test.ts.
 *
 * The matcher excludes `/api/*`, so every API route — including the public HMAC
 * lead-intake webhook (Phase 2) — is never subjected to session auth here; those routes
 * authenticate themselves (org membership, or the shared intake secret).
 */
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // No Supabase config (e.g. local/preview without env) -> serve without a refresh
  // rather than 500. Auth enforcement still happens in the API routes.
  if (!url || !key) {
    return response;
  }

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => {
          response.cookies.set(name, value, options);
        });
      },
    },
  });

  // Best-effort session refresh; never throw from middleware.
  try {
    await supabase.auth.getUser();
  } catch {
    /* ignore — refresh is best-effort, enforcement is in the API routes */
  }

  return response;
}

export const config = {
  matcher: [
    // Everything except API routes, Next internals, and static asset files.
    "/((?!api/|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
