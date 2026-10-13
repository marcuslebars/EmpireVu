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
 * Counts are batched in memory per process and flushed every ~15 s (or at 200 distinct keys), so
 * old-host API traffic costs no extra DB round trip per request; a restart may drop the last
 * ~15 s of counts, which is fine for "is anyone still using this?". Never throws, never awaits
 * on the request path, and keeps working (console only) when the table isn't there yet or the
 * Supabase env is missing. Uses a bare fetch to PostgREST, so it runs in the Edge middleware as
 * well as in Node routes and workers. One-shot jobs call flushLegacyUsage() before exiting.
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

export type LegacyUsageSink = (kind: LegacyUsageKind, key: string, sample: string | null, count: number) => Promise<void> | void;

/** Default sink: POST /rest/v1/rpc/note_legacy_usage with the service role key. */
const postgrestSink: LegacyUsageSink = async (kind, key, sample, count) => {
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
    body: JSON.stringify({ p_kind: kind, p_key: key, p_sample: sample, p_count: count }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
};

let sink: LegacyUsageSink = postgrestSink;
let warnedSinkFailure = false;

/** Counts waiting to be written, keyed by kind + key. */
const pending = new Map<string, { kind: LegacyUsageKind; key: string; sample: string | null; count: number }>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
export const LEGACY_USAGE_FLUSH_MS = 15_000;
/** Distinct keys that force an early flush (so a burst can't grow the map without bound). */
const MAX_PENDING = 200;

/** Kinds whose every use is console-logged (D6: every request with an old header). Hosts are
 *  high-volume (old mobile builds), so they log at most once a minute per host; the DB count
 *  is still exact. */
const LOG_EVERY_USE: ReadonlySet<LegacyUsageKind> = new Set<LegacyUsageKind>([
  "header",
  "env",
  "route",
  "stripe_metadata",
  "twilio_tag",
  "twilio_signature",
  "payload_key",
  "product_value",
  "inbound_email_domain",
]);
const lastConsoleAt = new Map<string, number>();

/** Tests swap the sink; pass null to restore the PostgREST sink. Clears anything pending. */
export function setLegacyUsageSink(next: LegacyUsageSink | null): void {
  sink = next ?? postgrestSink;
  warnedSinkFailure = false;
  pending.clear();
  lastConsoleAt.clear();
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
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

/** Write every pending count now. Never throws. Jobs call it before exiting. */
export async function flushLegacyUsage(): Promise<void> {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  if (pending.size === 0) return;
  const batch = [...pending.values()];
  pending.clear();
  await Promise.all(
    batch.map(async (row) => {
      try {
        await sink(row.kind, row.key, row.sample, row.count);
      } catch (err) {
        if (!warnedSinkFailure) {
          warnedSinkFailure = true;
          console.warn(
            "[legacy-usage] could not record counts (console only until restart; is migration 20261016100000 applied?):",
            err instanceof Error ? err.message : err,
          );
        }
      }
    }),
  );
}

function scheduleFlush(): void {
  if (pending.size >= MAX_PENDING) {
    void flushLegacyUsage();
    return;
  }
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushLegacyUsage();
  }, LEGACY_USAGE_FLUSH_MS);
  (flushTimer as { unref?: () => void }).unref?.();
}

/**
 * Count one use of an old name (buffered; written within ~15 s). Never throws, never blocks.
 */
export function noteLegacyUsage(kind: LegacyUsageKind, key: string, sample?: string | null): void {
  try {
    const k = clip(String(key ?? "").trim(), 120);
    if (!k) return;
    const s = sample ? clip(String(sample), 200) : null;
    const id = `${kind}\u0000${k}`;
    if (LOG_EVERY_USE.has(kind)) {
      console.info(`[legacy-usage] kind=${kind} key=${k}${s ? ` at=${s}` : ""}`);
    } else {
      const now = Date.now();
      if ((lastConsoleAt.get(id) ?? 0) + 60_000 <= now) {
        lastConsoleAt.set(id, now);
        console.info(`[legacy-usage] kind=${kind} key=${k}${s ? ` at=${s}` : ""} (logged at most once a minute; counted every time)`);
      }
    }
    const row = pending.get(id);
    if (row) {
      row.count += 1;
      if (s) row.sample = s;
    } else {
      pending.set(id, { kind, key: k, sample: s, count: 1 });
    }
    scheduleFlush();
  } catch {
    /* never let counting break a request */
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
        noteLegacyUsage("env", old, `instead of ${newName}`);
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
    noteLegacyUsage("header", oldName.toLowerCase(), sample ?? null);
    return old;
  }
  return null;
}
