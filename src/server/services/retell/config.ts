// Retell AI voice-receptionist integration config. SERVER-ONLY — never import into
// client code. All secrets come from Railway env (no VITE_ prefix). The integration
// is inert unless RETELL_INTAKE_ENABLED === "1".
//
// Signing secret: Retell signs its webhooks with your Retell API KEY (the key that
// bears the "webhook" badge in the dashboard) — the signing secret IS the API key.
// RETELL_WEBHOOK_SECRET is accepted as an alias/override in case a dedicated secret is
// ever configured, but normally only RETELL_API_KEY is set. See docs/retell-integration.md.

export interface RetellConfig {
  enabled: boolean;
  /** Retell API key — also the webhook signature key (the same value). */
  apiKey: string;
  /** Brand key the lead-intake routing consumes. A1 Marine Storage is tenant zero. */
  sourceSite: string;
  /** Marks every lead that came from the Retell receptionist. */
  leadSource: string;
  /** Replay window for webhook timestamps (ms). Retell's guidance is ~5 minutes. */
  toleranceMs: number;
}

export function getRetellConfig(): RetellConfig {
  return {
    enabled: process.env.RETELL_INTAKE_ENABLED === "1",
    // Prefer an explicit webhook secret if set, else the API key (which is what Retell
    // actually signs with). Either way this is the key HMAC verification uses.
    apiKey: (process.env.RETELL_WEBHOOK_SECRET?.trim() || process.env.RETELL_API_KEY?.trim()) ?? "",
    sourceSite: process.env.RETELL_SOURCE_SITE?.trim() || "a1marinestorage",
    leadSource: process.env.RETELL_LEAD_SOURCE?.trim() || "retell_voice_agent",
    toleranceMs: intEnv("RETELL_WEBHOOK_TOLERANCE_MS", 5 * 60 * 1000),
  };
}

function intEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
