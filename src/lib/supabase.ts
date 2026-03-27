import { createBrowserClient } from "@supabase/ssr";

import type { Database } from "@/server/db/database.types";
import { getSupabaseAnonKey, getSupabaseUrl } from "@/server/supabase/env";

export function createSupabaseBrowserClient() {
  return createBrowserClient<Database>(getSupabaseUrl(), getSupabaseAnonKey());
}

export const supabase = createSupabaseBrowserClient();
