import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/server/db/database.types";
import { getSupabaseSecretKey, getSupabaseUrl } from "@/server/supabase/env";

export function createSupabaseAdminClient() {
  return createClient<Database>(getSupabaseUrl(), getSupabaseSecretKey(), {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}