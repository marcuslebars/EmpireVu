/**
 * Online-booking deposits: what happens when the deposit invoice is paid, and releasing slots
 * whose deposit never came.
 *
 * SANCTIONED EXCEPTION (service role) for `expireDepositHolds` only: the worker's sweep has no
 * session; it reads bookings whose hold has run out across tenants and cancels each one
 * pinned to that booking's own organization_id (no request input). `onDepositInvoicePaid`
 * runs on whatever client marked the invoice paid (staff session or the Stripe webhook's),
 * pinned to the invoice's organization. Listed in docs/EMPIREVU_RUNBOOK.md.
 */
import type { Tables } from "@/server/db/database.types";
import { createActivityEvent } from "@/server/services/activity-events";
import { updateBookingStatus } from "@/server/services/bookings";
import { voidInvoice } from "@/server/services/invoices/service";
import { notifyOnlineBooking } from "@/server/services/push/notify";
import type { TenantServiceContext } from "@/server/services/shared";
import { createTask } from "@/server/services/tasks";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;
type Booking = Tables<"bookings">;

const ctxFor = (db: Db, organizationId: string): TenantServiceContext => ({ organizationId, actorProfileId: null, supabase: db }) as TenantServiceContext;

/** The deposit invoice was paid: the slot is the customer's. Never throws. */
export async function onDepositInvoicePaid(db: Db, invoice: { id: string; organization_id: string }): Promise<"confirmed" | "late" | "none"> {
  try {
    const { data } = await db.from("bookings").select("*").eq("organization_id", invoice.organization_id).eq("deposit_invoice_id", invoice.id).maybeSingle();
    const booking = data as Booking | null;
    if (!booking || booking.deposit_paid_at) return "none";
    const nowIso = new Date().toISOString();
    await db
      .from("bookings")
      .update({ deposit_paid_at: nowIso, hold_expires_at: null, ...(booking.status === "pending" ? { status: "confirmed" } : {}) })
      .eq("organization_id", booking.organization_id)
      .eq("id", booking.id);
    const ctx = ctxFor(db, booking.organization_id);
    await createActivityEvent(ctx, {
      companyId: booking.company_id,
      entityId: booking.id,
      entityType: "booking",
      eventType: "booking.deposit_paid",
      metadata: { bookingId: booking.id, invoiceId: invoice.id, depositCents: booking.deposit_cents },
      relatedEntityId: booking.contact_id,
      relatedEntityType: booking.contact_id ? "contact" : null,
    }).catch(() => undefined);

    if (booking.status === "cancelled") {
      // Paid after the hold ran out and the slot was released: a person needs to decide.
      await createTask(ctx, {
        title: `Deposit paid after the hold expired: "${booking.title}"`.slice(0, 200),
        description: "The slot had already been released. Rebook the customer, or refund the deposit from the invoice.",
        companyId: booking.company_id,
        contactId: booking.contact_id,
        bookingId: booking.id,
        priority: "high",
      }).catch(() => undefined);
      return "late";
    }
    await notifyOnlineBooking({
      organizationId: booking.organization_id,
      companyId: booking.company_id,
      bookingId: booking.id,
      title: "Deposit paid — booking confirmed",
      body: booking.title,
    });
    return "confirmed";
  } catch (err) {
    console.error("[online-booking] deposit paid handling failed:", err instanceof Error ? err.message : err);
    return "none";
  }
}

export interface HoldSweepResult {
  expired: number;
  extended: number;
}

/**
 * Worker: release online bookings whose deposit didn't come in time — cancel the booking
 * (so the slot reopens and reminders stop) and void its unpaid deposit invoice. A deposit
 * already on its way (a bank debit clearing) keeps the slot and is re-checked daily.
 */
export async function expireDepositHolds(now = new Date(), admin?: Db): Promise<HoldSweepResult> {
  const db = admin ?? createSupabaseAdminClient();
  const result: HoldSweepResult = { expired: 0, extended: 0 };
  const { data, error } = await db
    .from("bookings")
    .select("*")
    .lt("hold_expires_at", now.toISOString())
    .is("deposit_paid_at", null)
    .limit(200);
  if (error) throw error;
  for (const booking of (data ?? []) as Booking[]) {
    const ctx = ctxFor(db, booking.organization_id);
    try {
      if (booking.status !== "pending" && booking.status !== "confirmed") {
        await db.from("bookings").update({ hold_expires_at: null }).eq("organization_id", booking.organization_id).eq("id", booking.id);
        continue;
      }
      if (booking.deposit_invoice_id) {
        const { data: inv } = await db
          .from("invoices")
          .select("id, status, amount_paid_cents, pending_payment_cents")
          .eq("organization_id", booking.organization_id)
          .eq("id", booking.deposit_invoice_id)
          .maybeSingle();
        if (inv && (inv.pending_payment_cents > 0 || inv.amount_paid_cents > 0)) {
          await db
            .from("bookings")
            .update({ hold_expires_at: new Date(now.getTime() + 86_400_000).toISOString() })
            .eq("organization_id", booking.organization_id)
            .eq("id", booking.id);
          result.extended += 1;
          continue;
        }
        if (inv && inv.status !== "void" && inv.status !== "paid") {
          await voidInvoice(ctx, inv.id, "Booking hold expired before the deposit was paid.").catch((e: unknown) =>
            console.error("[online-booking] void failed:", e instanceof Error ? e.message : e),
          );
        }
      }
      await updateBookingStatus(ctx, { bookingId: booking.id, status: "cancelled" });
      await db.from("bookings").update({ hold_expires_at: null }).eq("organization_id", booking.organization_id).eq("id", booking.id);
      await createActivityEvent(ctx, {
        companyId: booking.company_id,
        entityId: booking.id,
        entityType: "booking",
        eventType: "booking.hold_expired",
        metadata: { bookingId: booking.id, depositCents: booking.deposit_cents },
        relatedEntityId: booking.contact_id,
        relatedEntityType: booking.contact_id ? "contact" : null,
      }).catch(() => undefined);
      result.expired += 1;
    } catch (err) {
      console.error(`[online-booking] releasing booking ${booking.id} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return result;
}
