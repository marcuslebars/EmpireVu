import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cookies, headers } from "next/headers";

import type { Database } from "@/server/db/database.types";
import { getSupabaseAnonKey, getSupabaseUrl } from "@/server/supabase/env";

/**
 * Pull a Supabase access token from `Authorization: Bearer <jwt>`.
 *
 * The web SPA authenticates with the same-origin auth cookie. The native mobile app
 * (Capacitor, served from capacitor://localhost or https://localhost) cannot carry that
 * cookie cross-origin, so it sends the session's access token instead. Exported for tests.
 */
export function readBearerToken(authorization: string | null | undefined): string | null {
  if (!authorization) {
    return null;
  }

  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  return match ? match[1] : null;
}

/**
 * Return type pinned to the top-level supabase-js `SupabaseClient`.
 *
 * @supabase/ssr bundles an older supabase-js whose 3-param `SupabaseClient` types
 * `.insert()` / `.update()` arguments as `never`; the top-level supabase-js (used by
 * the admin client) is the 4-param form and types writes correctly. The runtime object
 * is a real `SupabaseClient` either way, so this single, documented assertion bridges
 * the version skew — and in doing so removes the ~40 `.from(...) as any` casts that
 * every service previously needed to make a write typecheck.
 */
export function createSupabaseServerClient(): SupabaseClient<Database, "public"> {
  const bearerToken = readBearerToken(headers().get("authorization"));

  if (bearerToken) {
    return createBearerClient(bearerToken);
  }

  const cookieStore = cookies();

  return createServerClient<Database, "public">(getSupabaseUrl(), getSupabaseAnonKey(), {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        cookiesToSet.forEach(({ name, value, options }) => {
          cookieStore.set(name, value, options);
        });
      },
    },
  }) as unknown as SupabaseClient<Database, "public">;
}

/**
 * A request-scoped client acting as the token's user. PostgREST calls carry the token,
 * so RLS applies exactly as it does for a cookie session, and `auth.getUser()` validates
 * the token against Supabase Auth — `getAuthenticatedUser` needs no change. An expired
 * or forged token fails `getUser()` and the route answers 401.
 */
function createBearerClient(accessToken: string): SupabaseClient<Database, "public"> {
  const client = createClient<Database, "public">(getSupabaseUrl(), getSupabaseAnonKey(), {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });

  const getUser = client.auth.getUser.bind(client.auth);
  client.auth.getUser = (jwt?: string) => getUser(jwt ?? accessToken);

  return client;
}
