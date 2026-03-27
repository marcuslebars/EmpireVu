import { createBrowserClient } from "@supabase/ssr";

import type { Database } from "@/server/db/database.types";

function getSupabaseUrl(): string {
  return import.meta.env.NEXT_PUBLIC_SUPABASE_URL as string || "";
}

function getSupabaseAnonKey(): string {
  return import.meta.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string || "";
}

export function createSupabaseBrowserClient() {
  const url = getSupabaseUrl();
  const anonKey = getSupabaseAnonKey();

  if (!url || !anonKey) {
    console.warn("Supabase environment variables not configured. Auth will be disabled.");
  }

  return createBrowserClient<Database>(url || "https://placeholder.supabase.co", anonKey || "placeholder");
}

export const supabase = createSupabaseBrowserClient();
