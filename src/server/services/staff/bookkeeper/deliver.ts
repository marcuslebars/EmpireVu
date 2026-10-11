/**
 * Sending a reminder text, exactly once: every text is an invoice_reminder_texts row with a
 * unique (invoice_id, reminder_key). Scheduled texts are inserted already `claimed` by the sweep
 * (the unique key is the claim). Owner-approved texts (final notice, "remind Jones now") are
 * inserted `queued` and go out right away inside the 09:00–20:00 Mon–Sat window, else on the
 * next sweep inside it; `queued → claimed` is a conditional update, so overlapping workers send once.
 *
 * After a send, invoices.last_reminder_at is stamped — the email reminder sweep
 * (invoices/reminders.ts) already treats that as "today's reminder went out", so a customer never
 * gets an email and a text about the same invoice on the same day.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { recordInvoiceEvent } from "@/server/services/invoices/common";
import { sendOwnerSms } from "@/server/services/owner-channel/common";
import { isOpen, loadCompanyCtx, loadContact, loadInvoice, owingCents, reminderConsent, textCustomer, type CompanyCtx } from "./context";
import type { BookkeeperContact, BookkeeperInvoice, Db, InvoiceReminderTextRow, ReminderTextKind } from "./db-types";
import { fullNameOf, inCustomerWindow, ownerMoney } from "./format";

export interface SendOutcome {
  status: "sent" | "blocked" | "failed" | "skipped" | "queued";
  reason?: string;
}

/** Send a row this worker already claimed; records the outcome. Never throws. */
export async function sendClaimedReminder(
  admin: AdminClient,
  ctx: CompanyCtx,
  invoice: BookkeeperInvoice,
  contact: BookkeeperContact | null,
  row: Pick<InvoiceReminderTextRow, "id" | "kind" | "body" | "reminder_key">,
  nowMs: number,
): Promise<SendOutcome> {
  const db = admin as Db;
  const finish = async (status: SendOutcome["status"], reason?: string) => {
    await db
      .from("invoice_reminder_texts")
      .update({ status, reason: reason ?? null, sent_at: status === "sent" ? new Date(nowMs).toISOString() : null })
      .eq("id", row.id)
      .eq("organization_id", ctx.organizationId);
    return { status, reason };
  };
  try {
    if (!contact || !contact.phone?.trim()) return await finish("blocked", "no_phone");
    if (!row.body?.trim()) return await finish("skipped", "empty_body");
    const result = await textCustomer(admin, ctx, contact, row.body, reminderConsent(contact, invoice));
    if (result.status !== "sent") return await finish(result.status, result.reason ?? undefined);
    const at = new Date(nowMs).toISOString();
    await finish("sent");
    // Coordinates with the email reminders: "a reminder went out today".
    await db.from("invoices").update({ last_reminder_at: at }).eq("id", invoice.id).eq("organization_id", ctx.organizationId);
    const collections: Record<string, unknown> = { last_sms_at: at };
    if (row.kind === "final_notice") collections.final_notice_status = "sent";
    await db.from("invoice_collections").update(collections).eq("organization_id", ctx.organizationId).eq("invoice_id", invoice.id);
    await recordInvoiceEvent(admin as never, {
      organizationId: ctx.organizationId,
      invoiceId: invoice.id,
      eventType: "sms_reminder_sent",
      metadata: { kind: row.kind, key: row.reminder_key, to: contact.phone },
    });
    return { status: "sent" };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error("[bookkeeper] reminder send failed", row.id, reason);
    return finish("failed", reason).catch(() => ({ status: "failed" as const, reason }));
  }
}

/**
 * Deliver one queued (owner-approved) text, if this worker wins the claim. The invoice must still
 * be open with the SAME balance the owner saw; otherwise nothing goes out (and the owner hears why).
 */
export async function deliverQueuedReminder(admin: AdminClient, row: InvoiceReminderTextRow, nowMs: number, preloaded?: CompanyCtx | null): Promise<SendOutcome> {
  const db = admin as Db;
  const ctx = preloaded ?? (await loadCompanyCtx(admin, row.organization_id, row.company_id));
  if (!ctx) return { status: "skipped", reason: "no_company" };
  if (!inCustomerWindow(nowMs, ctx.timeZone)) return { status: "queued" };
  const { data: claimed } = await db
    .from("invoice_reminder_texts")
    .update({ status: "claimed" })
    .eq("id", row.id)
    .eq("organization_id", row.organization_id)
    .eq("status", "queued")
    .select("id");
  if (((claimed ?? []) as unknown[]).length === 0) return { status: "skipped", reason: "already_claimed" };

  const invoice = await loadInvoice(admin, ctx, row.invoice_id);
  const skip = async (reason: string) => {
    await db.from("invoice_reminder_texts").update({ status: "skipped", reason }).eq("id", row.id).eq("organization_id", row.organization_id);
    if (row.kind === "final_notice") {
      await db.from("invoice_collections").update({ final_notice_status: "skipped" }).eq("organization_id", row.organization_id).eq("invoice_id", row.invoice_id);
    }
    return { status: "skipped" as const, reason };
  };
  if (!invoice || !isOpen(invoice)) return skip("paid_or_closed");
  const contact = await loadContact(admin, ctx, invoice.contact_id);
  if (row.balance_cents != null && owingCents(invoice) !== row.balance_cents) {
    const outcome = await skip("balance_changed");
    if (ctx.ownerPhone) {
      await sendOwnerSms(admin, {
        to: ctx.ownerPhone,
        body: `Didn't send the ${row.kind === "final_notice" ? "final notice" : "reminder"} to ${fullNameOf(contact)}: the balance changed to ${ownerMoney(owingCents(invoice))} since you OK'd it. Text me "remind ${firstWord(fullNameOf(contact))}" to send a fresh one.`,
        organizationId: ctx.organizationId,
        companyId: ctx.companyId,
        platformBrand: ctx.platformBrand,
      });
    }
    return outcome;
  }
  return sendClaimedReminder(admin, ctx, invoice, contact, row, nowMs);
}

function firstWord(name: string): string {
  return name.split(/\s+/)[0] ?? name;
}

/**
 * Queue an owner-approved text (idempotent on the key) and send it now when inside the window.
 * Returns the row's outcome ("queued" = it goes at the next 9am).
 */
export async function queueReminder(
  admin: AdminClient,
  ctx: CompanyCtx,
  invoice: BookkeeperInvoice,
  input: { key: string; kind: ReminderTextKind; body: string; balanceCents: number; approvalId: string | null },
  nowMs: number,
): Promise<SendOutcome> {
  const db = admin as Db;
  const { data, error } = await db
    .from("invoice_reminder_texts")
    .insert({
      organization_id: ctx.organizationId,
      company_id: ctx.companyId,
      invoice_id: invoice.id,
      contact_id: invoice.contact_id,
      reminder_key: input.key,
      kind: input.kind,
      status: "queued",
      body: input.body,
      balance_cents: input.balanceCents,
      approval_id: input.approvalId,
    })
    .select("*")
    .single();
  let row = data as InvoiceReminderTextRow | null;
  if (error || !row) {
    // Already queued by an earlier run of this approval: report where it stands.
    const { data: existing } = await db
      .from("invoice_reminder_texts")
      .select("*")
      .eq("organization_id", ctx.organizationId)
      .eq("invoice_id", invoice.id)
      .eq("reminder_key", input.key)
      .maybeSingle();
    row = existing as InvoiceReminderTextRow | null;
    if (!row) throw error ?? new Error("Could not queue the text.");
    if (row.status !== "queued") return { status: row.status === "claimed" ? "sent" : (row.status as SendOutcome["status"]), reason: row.reason ?? undefined };
  }
  return deliverQueuedReminder(admin, row, nowMs, ctx);
}
