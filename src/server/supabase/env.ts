function getRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export function getSupabaseUrl(): string {
  return getRequiredEnv("NEXT_PUBLIC_SUPABASE_URL");
}

export function getSupabaseAnonKey(): string {
  // Supabase renamed the anon key to the "publishable" key; Railway provides
  // NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY. Accept either name (publishable wins).
  return (
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    getRequiredEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY")
  );
}

/**
 * The server-only key that bypasses RLS (used ONLY by createSupabaseAdminClient, under the
 * sanctioned-exception rules in docs/EMPIREVU_RUNBOOK.md).
 *
 * Prefers Supabase's new **secret key** (`SUPABASE_SECRET_KEY`, `sb_secret_…`): individually
 * revocable/rotatable, and rejected by Supabase if ever sent from a browser. Falls back to the
 * legacy JWT `SUPABASE_SERVICE_ROLE_KEY` only during the switch-over; once every service has
 * SUPABASE_SECRET_KEY, delete the legacy variable and disable legacy API keys in Supabase.
 * Never give either a VITE_ / NEXT_PUBLIC_ name.
 */
export function getSupabaseSecretKey(): string {
  const secret = process.env.SUPABASE_SECRET_KEY?.trim();
  if (secret) {
    if (secret.startsWith("sb_publishable_")) {
      throw new Error(
        "SUPABASE_SECRET_KEY holds a publishable key (sb_publishable_…). Use the secret key (sb_secret_…) from Supabase → Project Settings → API Keys.",
      );
    }
    return secret;
  }
  const legacy = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (legacy) return legacy;
  throw new Error("Missing required environment variable: SUPABASE_SECRET_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY)");
}

/** Which variable supplied the admin key — for health/diagnostics only (never the value). */
export function supabaseSecretKeySource(): "SUPABASE_SECRET_KEY" | "SUPABASE_SERVICE_ROLE_KEY" | null {
  if (process.env.SUPABASE_SECRET_KEY?.trim()) return "SUPABASE_SECRET_KEY";
  if (process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) return "SUPABASE_SERVICE_ROLE_KEY";
  return null;
}