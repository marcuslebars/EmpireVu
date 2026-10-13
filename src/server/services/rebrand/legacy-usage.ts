/**
 * Everdoer rebrand: counting old-name use (REBRAND_PLAN.md §8, decision D6).
 *
 * Every compatibility shim that still accepts an old EmpireVu / CrankLeads name (header, host, env
 * var, route alias, Stripe metadata, Twilio tag…) calls noteLegacyUsage(). Each use is written to
 * the console as `[legacy-usage] kind=… key=…` and counted per UTC day in public.legacy_usage
 * (migration 20261016100000). A shim is removed only after its kind/key shows zero uses for 30 days:
 *
 *   select kind, key, max(day) as last_day, sum(count) from public.legacy_usage
 *    where day > current_date - 30 group by 1, 2 order by 1, 2;
 *
 * Fire-and-forget: never throws, never awaits on the request path, and keeps working (console
 * only) when the table isn't there yet or the Supabase env is missing. Uses a bare fetch to
 * PostgREST so it runs in the Edge middleware as well as in Node routes and workers.
 *
 * Never pass a secret, header VALUE, body or query string as `key` or `sample`; pass the old
 * NAME as key and, at most, a path or host as the sample. sampleFromUrl() strips the query.
 */

export type LegacyUsageKind =
  | "header"
  | "host"
  | "env"
  | "route"
  | "stripe_metadata"
  | "twilio_tag"
  | "twilio_signature"
  | "payload_key"
  | "product_value"
  | "inbound_email_domain";

export type LegacyUsageSink = (kind: LegacyUsageKind, key: string, sample: string | null) => Promise<void> | void;

/** Default sink: POST /rest/v1/rpc/note_legacy_usage with the service role key. */
const postgrestSink: LegacyUsageSink = async (kind, key, sample) => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceKey) return;
  const res = await fetch(`${url.replace(/\/+$/, "")}/rest/v1/rpc/note_legacy_usage`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p_kind: kind, p_key: key, p_sample: sample }),
    cache: "no-store",
  });
  if (!res.ok && !warnedSinkFailure) {
    warnedSinkFailure = true;
    console.warn(`[legacy-usage] could not record counts (HTTP ${res.status}); console only until restart. Is migration 20261016100000 applied?`);
  }
};

let sink: LegacyUsageSink = postgrestSink;
let warnedSinkFailure = false;

/** Tests swap the sink; pass null to restore the PostgREST sink. */
export function setLegacyUsageSink(next: LegacyUsageSink | null): void {
  sink = next ?? postgrestSink;
  warnedSinkFailure = false;
}

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** "https://x/a/b?token=…" → "/a/b"; a bare path loses its query too. PURE. */
export function sampleFromUrl(url: string | URL | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = typeof url === "string" ? new URL(url, "http://local") : url;
    return clip(u.pathname, 200);
  } catch {
    return null;
  }
}

/**
 * Count one use of an old name. Returns the (possibly ignored) write so a caller that can
 * (Edge middleware's event.waitUntil) may keep the runtime alive for it; others ignore it.
 */
export function noteLegacyUsage(kind: LegacyUsageKind, key: string, sample?: string | null): Promise<void> {
  const k = clip(String(key ?? "").trim(), 120);
  if (!k) return Promise.resolve();
  const s = sample ? clip(String(sample), 200) : null;
  console.info(`[legacy-usage] kind=${kind} key=${k}${s ? ` at=${s}` : ""}`);
  try {
    return Promise.resolve(sink(kind, k, s)).catch((err) => {
      if (!warnedSinkFailure) {
        warnedSinkFailure = true;
        console.warn("[legacy-usage] could not record counts:", err instanceof Error ? err.message : err);
      }
    });
  } catch {
    return Promise.resolve();
  }
}

// ── env fallbacks ─────────────────────────────────────────────────────────────────────

const notedEnv = new Set<string>();

/**
 * Read an env var by its new EVERDOER_* name, falling back to old names (in order). A fallback
 * hit is counted once per process (kind "env", key = the old name), so the logs show which
 * services still need the new variable set. Empty / whitespace values count as unset.
 * Shim removal: drop `oldNames` once legacy_usage shows no 'env' rows for 30 days (PR 8).
 */
export function envWithFallback(newName: string, oldNames: readonly string[], env: Record<string, string | undefined> = process.env): string | undefined {
  const fresh = env[newName]?.trim();
  if (fresh) return fresh;
  for (const old of oldNames) {
    const value = env[old]?.trim();
    if (value) {
      if (!notedEnv.has(old)) {
        notedEnv.add(old);
        void noteLegacyUsage("env", old, `instead of ${newName}`);
      }
      return value;
    }
  }
  return undefined;
}

/** Tests only: forget which env fallbacks were already counted. */
export function resetLegacyEnvNotes(): void {
  notedEnv.clear();
}

// ── header fallbacks ──────────────────────────────────────────────────────────────────

interface HeaderSource {
  get(name: string): string | null;
}

/**
 * Read a header by its new x-everdoer-* name, falling back to the old x-empirevu-* name. A
 * fallback hit is counted (kind "header", key = the old name, sample = the path) on EVERY request,
 * per D6. If both are sent, the new one wins and nothing is counted.
 * Shim removal: once the A1 sites, Retell agents and Telnyx are switched and legacy_usage shows
 * zero 'header' rows for 30 days (PR 8).
 */
export function headerWithFallback(
  headers: HeaderSource,
  newName: string,
  oldName: string,
  sample?: string | null,
): string | null {
  const fresh = headers.get(newName);
  if (fresh != null && fresh !== "") return fresh;
  const old = headers.get(oldName);
  if (old != null && old !== "") {
    void noteLegacyUsage("header", oldName.toLowerCase(), sample ?? null);
    return old;
  }
  return null;
}
