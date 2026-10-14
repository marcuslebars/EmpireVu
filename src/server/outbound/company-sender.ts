/**
 * D7 (Everdoer rebrand): the sending company's own From address, `companies.email_from_address`.
 *
 * The column is set by the service role only (migration 20261017100000 pins the A1 companies
 * to their current A1 sender; there is no client grant and no settings UI), so any value
 * here is on a domain the platform's Resend account covers. outbound/email.ts
 * resolveFromAddress puts it first, then EVERDOER_DEFAULT_FROM_EMAIL, then today's
 * OUTBOUND_FROM_EMAIL.
 *
 * Callers that already loaded the company row with `select("*")` read it with
 * companyFromAddressOf(row). The others (deliverMessage, invoices, the staff roles) call
 * loadCompanyFromAddress, which reads only this column and caches it per company for a few
 * minutes, so a sweep sending many emails for one company costs one query.
 *
 * Fail-safe: if the column can't be read (the migration isn't applied yet, a network blip),
 * the company is treated as sending from TODAY's address (OUTBOUND_FROM_EMAIL ||
 * LEAD_FROM_EMAIL), never the new platform default. A company pinned to its own sender
 * (A1) must never have a customer email go out from @everdoer.com because a read failed.
 *
 * Deliberately imports nothing from outbound/email.ts: many tests mock that module with
 * only `sendEmail`.
 */
import type { TenantServiceContext } from "@/server/services/shared";
import type { createSupabaseAdminClient } from "@/server/supabase/admin";

type Db = TenantServiceContext["supabase"];
/** The user's session client or the service-role client: both read one column of one company. */
type AnyDb = Db | ReturnType<typeof createSupabaseAdminClient>;

const TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 5000;
const cache = new Map<string, { value: string | null; at: number }>();
let warned = false;

/**
 * The From ADDRESS a message goes out from (D7, Everdoer rebrand):
 *   1. the company's own sender (`companies.email_from_address`), when the mail is sent on
 *      a company's behalf and it has one (the A1 companies are pinned to their A1 sender);
 *   2. EVERDOER_DEFAULT_FROM_EMAIL, the platform default (hello@everdoer.com), set only
 *      once everdoer.com passes SPF/DKIM/DMARC in Resend;
 *   3. today's OUTBOUND_FROM_EMAIL, then LEAD_FROM_EMAIL.
 * With no company value and EVERDOER_DEFAULT_FROM_EMAIL unset this is exactly the old
 * `OUTBOUND_FROM_EMAIL || LEAD_FROM_EMAIL`. `||` not `??` throughout: a variable that
 * exists but is blank (easy to do in a hosting dashboard) falls back instead of silently
 * defeating the fallback. Platform mail (invites, welcome, operator mail) passes no
 * company value, so it gets 2, then 3. sendEmail applies it to every message.
 */
export function resolveFromAddress(companyFrom?: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  return (
    usableCompanyAddress(companyFrom) ||
    env.EVERDOER_DEFAULT_FROM_EMAIL?.trim() ||
    env.OUTBOUND_FROM_EMAIL ||
    env.LEAD_FROM_EMAIL ||
    null
  );
}

/** A company's address only if it's one plain address (the DB checks the shape too). */
function usableCompanyAddress(value: string | null | undefined): string | null {
  const v = value?.trim();
  if (!v || !/^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/.test(v)) return null;
  return v;
}

/** The company's own sender from a row that has it (e.g. loaded with `select("*")`), else null. */
export function companyFromAddressOf(row: unknown): string | null {
  if (!row || typeof row !== "object" || !("email_from_address" in row)) return null;
  const value = (row as { email_from_address: unknown }).email_from_address;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Today's sender address (no display name), used when the company's own can't be read. */
function legacySenderAddress(): string | null {
  const raw = process.env.OUTBOUND_FROM_EMAIL || process.env.LEAD_FROM_EMAIL || "";
  const bare = (raw.match(/<([^>]+)>/)?.[1] ?? raw).trim();
  return bare || null;
}

/**
 * The company's own From address, or null when it has none (→ the platform default).
 * Never throws; see the fail-safe note above.
 */
export async function loadCompanyFromAddress(
  db: AnyDb,
  companyId: string | null | undefined,
  now: number = Date.now(),
): Promise<string | null> {
  if (!companyId) return null;
  const hit = cache.get(companyId);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  try {
    const { data, error } = await (db as Db).from("companies").select("email_from_address").eq("id", companyId).maybeSingle();
    if (error) throw new Error(error.message);
    const value = companyFromAddressOf(data);
    if (cache.size >= MAX_ENTRIES) cache.clear();
    cache.set(companyId, { value, at: now });
    return value;
  } catch (err) {
    if (!warned) {
      warned = true;
      console.error(
        "[outbound] couldn't read companies.email_from_address; sending from OUTBOUND_FROM_EMAIL as before:",
        err instanceof Error ? err.message : err,
      );
    }
    return legacySenderAddress();
  }
}

/** Tests only. */
export function resetCompanySenderCache(): void {
  cache.clear();
  warned = false;
}
