import { createBrowserClient } from "@supabase/ssr";

import type { Database } from "@/server/db/database.types";

function getSupabaseUrl(): string {
  return (
    (import.meta.env.VITE_SUPABASE_URL as string | undefined) ||
    (import.meta.env.NEXT_PUBLIC_SUPABASE_URL as string | undefined) ||
    ""
  );
}

function getSupabaseAnonKey(): string {
  return (
    (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined) ||
    (import.meta.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string | undefined) ||
    ""
  );
}

function getSupabaseConfigStatus(): {
  hasUrl: boolean;
  hasKey: boolean;
  source: "vite" | "next-public" | "none";
} {
  const url = getSupabaseUrl();
  const key = getSupabaseAnonKey();
  const hasUrl = Boolean(url);
  const hasKey = Boolean(key);

  let source: "vite" | "next-public" | "none" = "none";
  if (hasUrl && hasKey) {
    if (import.meta.env.VITE_SUPABASE_URL || import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY) {
      source = "vite";
    } else {
      source = "next-public";
    }
  }

  return { hasUrl, hasKey, source };
}

export function getSupabaseConfigDiagnostic(): {
  isConfigured: boolean;
  url: string | null;
  keySource: string | null;
} {
  const status = getSupabaseConfigStatus();
  const url = getSupabaseUrl();

  let keySource: string | null = null;
  if (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY) {
    keySource = "VITE_SUPABASE_PUBLISHABLE_KEY";
  } else if (import.meta.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    keySource = "NEXT_PUBLIC_SUPABASE_ANON_KEY";
  }

  const diagnostic = {
    isConfigured: status.hasUrl && status.hasKey,
    url: url || null,
    keySource,
  };

  if (!diagnostic.isConfigured) {
    console.error(
      `[Supabase] AUTH NOT CONFIGURED — Missing environment variables: ` +
      `${!status.hasUrl ? "VITE_SUPABASE_URL" : ""} ` +
      `${!status.hasKey ? "VITE_SUPABASE_PUBLISHABLE_KEY" : ""}. ` +
      `Sign-in will not work. Set these in your .env file and restart.`,
      diagnostic
    );
  } else {
    console.log(`[Supabase] Config OK (source: ${diagnostic.keySource}, url: ${diagnostic.url})`);
  }

  return diagnostic;
}

let _supabaseClient: ReturnType<typeof createBrowserClient<Database>> | null = null;

export function getSupabaseBrowserClient(): ReturnType<typeof createBrowserClient<Database>> | null {
  if (_supabaseClient) {
    return _supabaseClient;
  }

  const url = getSupabaseUrl();
  const anonKey = getSupabaseAnonKey();
  const configStatus = getSupabaseConfigStatus();

  if (!configStatus.hasUrl || !configStatus.hasKey) {
    const missing = [
      !configStatus.hasUrl ? "VITE_SUPABASE_URL" : null,
      !configStatus.hasKey ? "VITE_SUPABASE_PUBLISHABLE_KEY" : null,
    ].filter(Boolean);

    console.error(
      `[Supabase] Missing env vars: ${missing.join(", ")}. ` +
      `Cannot create Supabase client — auth will fail.`
    );
    return null;
  }

  _supabaseClient = createBrowserClient<Database>(url, anonKey);
  return _supabaseClient;
}

export const supabase = getSupabaseBrowserClient();
