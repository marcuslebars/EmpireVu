import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/server/db/database.types";
import { getSupabaseServiceRoleKey, getSupabaseUrl } from "@/server/supabase/env";

export function createSupabaseAdminClient() {
  return createClient<Database>(getSupabaseUrl(), getSupabaseServiceRoleKey(), {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}