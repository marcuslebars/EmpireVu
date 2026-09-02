import { createServerClient, type CookieOptions } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

import type { Database } from "@/server/db/database.types";
import { getSupabaseAnonKey, getSupabaseUrl } from "@/server/supabase/env";

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