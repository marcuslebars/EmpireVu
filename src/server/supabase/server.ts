import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import type { Database } from "@/server/db/database.types";
import { getSupabaseAnonKey, getSupabaseUrl } from "@/server/supabase/env";

export function createSupabaseServerClient() {
  const cookieStore = cookies();

  return createServerClient<Database, "public">(getSupabaseUrl(), getSupabaseAnonKey(), {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value, options }) => {
          cookieStore.set(name, value, options);
        });
      },
    },
  });
}