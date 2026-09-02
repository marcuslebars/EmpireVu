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
import { sendExpiryReminderEmail } from "./notify";
import { recordPublicEvent } from "./public-service";

/** Statuses a sweep may expire. Deliberately narrow — see the note above. */
export const EXPIRABLE_STATUSES = ["sent", "viewed"] as const;

export interface ExpirySweepResult {
  scanned: number;
  expired: string[];
}

export async function sweepExpiredQuotes(now = new Date(), limit = 500): Promise<ExpirySweepResult> {
  const db = createSupabaseAdminClient();
  const cutoff = now.toISOString();

  const { data, error } = await db
    .from("quotes")
    .select("id, organization_id, quote_number, valid_until, expires_at, status")
    .in("status", [...EXPIRABLE_STATUSES])
    .lte("expires_at", cutoff)
    .limit(limit);
  if (error) throw error;

  const rows = data ?? [];
  const expired: string[] = [];

  for (const row of rows) {
    // Re-assert the status in the WHERE clause: a customer may have approved in
    // the moments between the select and this update, and that approval wins.
    const { data: updated, error: updateErr } = await db
      .from("quotes")
      .update({ status: "expired" })
      .eq("id", row.id)
      .in("status", [...EXPIRABLE_STATUSES])
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

export interface ReminderSweepResult {
  scanned: number;
  reminded: string[];
}

/** Days before valid_until that the single reminder goes out. */
export const REMINDER_LEAD_DAYS = 5;

/**
 * Send the one expiry reminder for quotes approaching valid_until.
 *
 * The idempotency guard is expiry_reminder_sent_at, claimed in the UPDATE's WHERE
 * clause BEFORE the email is sent. That ordering is deliberate: claiming first
 * risks a quote silently missing its reminder if the send then fails, while
 * sending first risks re-sending it every night for five nights. A missed nudge
 * is a far smaller harm than nagging a customer daily — and daily repeats are how
 * a sending domain gets marked as spam.
 *
 * Only sent/viewed qualify. An approved quote does not need chasing, and an
 * expired one is past the point where a nudge helps.
 */
export async function sweepExpiryReminders(
  now = new Date(),
  limit = 500,
): Promise<ReminderSweepResult> {
  const db = createSupabaseAdminClient();
  const windowEnd = new Date(now.getTime() + REMINDER_LEAD_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await db
    .from("quotes")
    .select("id, organization_id, expires_at, status")
    .in("status", [...EXPIRABLE_STATUSES])
    .is("expiry_reminder_sent_at", null)
    .gt("expires_at", now.toISOString()) // not already expired
    .lte("expires_at", windowEnd) // within the lead window
    .limit(limit);
  if (error) throw error;

  const rows = data ?? [];
  const reminded: string[] = [];

  for (const row of rows) {
    // Claim it first — see the note above.
    const { data: claimed, error: claimErr } = await db
      .from("quotes")
      .update({ expiry_reminder_sent_at: now.toISOString() })
      .eq("id", row.id)
      .is("expiry_reminder_sent_at", null)
      .in("status", [...EXPIRABLE_STATUSES])
      .select("id")
      .maybeSingle();

    if (claimErr) {
      console.error(`[quotes] reminder claim failed for ${row.id}:`, claimErr);
      continue;
    }
    if (!claimed) continue; // another run claimed it, or it moved on

    const sent = await sendExpiryReminderEmail(row.id, now);
    if (sent) reminded.push(row.id);
  }

  return { scanned: rows.length, reminded };
}
