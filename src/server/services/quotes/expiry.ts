/**
 * Quote expiry sweep — cron.
 *
 * Moves quotes past their valid_until from sent/viewed to 'expired'. Runs under the
 * service-role client, like the other background jobs.
 *
 * The status filter is the safety property, not an optimisation: only 'sent' and
 * 'viewed' are swept. A quote the customer has APPROVED must never be retracted by
 * a background job — they committed, and possibly paid, on a price we offered.
 * lifecycle.ts encodes the same rule (approved -> expired is not a legal edge), so
 * this filter and that table have to agree; the tests assert both.
 */
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { recordPublicEvent } from "./public-service";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

/** Statuses a sweep may expire. Deliberately narrow — see the note above. */
export const EXPIRABLE_STATUSES = ["sent", "viewed"] as const;

export interface ExpirySweepResult {
  scanned: number;
  expired: string[];
}

export async function sweepExpiredQuotes(now = new Date(), limit = 500): Promise<ExpirySweepResult> {
  const db = createSupabaseAdminClient() as Db;
  const cutoff = now.toISOString();

  const { data, error } = await db
    .from("quotes")
    .select("id, organization_id, quote_number, valid_until, expires_at, status")
    .in("status", EXPIRABLE_STATUSES as unknown as string[])
    .lte("expires_at", cutoff)
    .limit(limit);
  if (error) throw error;

  const rows: Db[] = data ?? [];
  const expired: string[] = [];

  for (const row of rows) {
    // Re-assert the status in the WHERE clause: a customer may have approved in
    // the moments between the select and this update, and that approval wins.
    const { data: updated, error: updateErr } = await db
      .from("quotes")
      .update({ status: "expired" })
      .eq("id", row.id)
      .in("status", EXPIRABLE_STATUSES as unknown as string[])
      .select("id, organization_id")
      .maybeSingle();

    if (updateErr) {
      console.error(`[quotes] expiry sweep failed for ${row.id}:`, updateErr);
      continue;
    }
    if (!updated) continue; // status changed underneath us — leave it alone

    expired.push(updated.id);
    await recordPublicEvent(updated.organization_id, updated.id, "expired", {
      validUntil: row.valid_until ?? row.expires_at ?? null,
    });
  }

  return { scanned: rows.length, expired };
}
