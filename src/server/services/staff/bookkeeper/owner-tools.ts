/**
 * The Bookkeeper's tools for the owner-by-text agent. Scoped to the company the owner's phone
 * resolved to (state.scope); invoice ids/numbers/names from the model are only matched inside it.
 * Money changes never happen here: record_offline_payment and remind_now create an approval
 * (record_payment / send_invoice_reminder) and hand back the exact question ("Reply Y 12 …").
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import type { ToolRunState } from "@/server/services/owner-channel/tools";
import { localWallTimeToUtcMs } from "@/server/services/monthly-scorecard/weeks";
import { checkConsent } from "@/server/services/workflow-engine/messaging";
import { prettyPhone } from "@/server/services/front-desk/approval-text";
import type { RoleOwnerTool } from "@/server/services/staff/types";
import { createBookkeeperApproval, inlineReplyLine, KIND_RECORD_PAYMENT, KIND_SEND_REMINDER, PAYMENT_METHODS, pendingApprovalFor } from "./approvals";
import { AGING_BUCKETS, agingSummary, cashSnapshot, loadCashInputs, loadOpenInvoicesWithNames } from "./ar";
import { loadCompanyCtx, loadContact, owingCents, reminderConsent, todayIn, type CompanyCtx } from "./context";
import type { BookkeeperInvoice } from "./db-types";
import { clip, daysBetween, dollarsToCents, fullNameOf, isDateKey, ownerMoney, shortDate } from "./format";
import { reminderInput } from "./reminders";
import { reminderText, toneForDays } from "./texts";

export const BOOKKEEPER_OFF = "The bookkeeper is off for this business (Settings > AI front desk > Bookkeeper).";
/** The owner agent clips replies at 480 characters; an approval question must fit whole. */
const MAX_TELL_OWNER = 470;

type Input = Record<string, unknown>;

async function enabledCtx(state: ToolRunState): Promise<CompanyCtx | { error: string }> {
  const ctx = await loadCompanyCtx(state.admin, state.scope.organizationId, state.scope.companyId);
  if (!ctx) return { error: "Business not found." };
  if (!ctx.settings.enabled) return { error: BOOKKEEPER_OFF };
  return ctx;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

type NamedInvoice = BookkeeperInvoice & { customer: string };

/** Match open invoices by id, number or customer name/phone (inside the scope only). PURE. */
export function matchInvoices(invoices: NamedInvoice[], input: Input): NamedInvoice[] {
  const id = str(input.invoice_id);
  if (id) return invoices.filter((i) => i.id === id);
  const number = str(input.invoice_number)?.toLowerCase().replace(/^#/, "");
  if (number) {
    const exact = invoices.filter((i) => (i.invoice_number ?? "").toLowerCase() === number);
    if (exact.length) return exact;
    return invoices.filter((i) => (i.invoice_number ?? "").toLowerCase().endsWith(number));
  }
  const customer = str(input.customer)?.toLowerCase();
  if (!customer) return [];
  const tokens = customer.split(/\s+/).filter((t) => t.length > 0);
  return invoices.filter((i) => {
    const name = i.customer.toLowerCase();
    return tokens.every((t) => name.includes(t));
  });
}

function choices(list: NamedInvoice[], today: string) {
  return list.slice(0, 5).map((i) => ({
    invoice_id: i.id,
    invoice: i.invoice_number,
    customer: i.customer,
    owing: ownerMoney(owingCents(i)),
    due: i.due_date ? shortDate(i.due_date) : null,
    days_late: i.due_date ? Math.max(0, daysBetween(i.due_date, today)) : 0,
  }));
}

async function pickInvoice(admin: AdminClient, ctx: CompanyCtx, input: Input, nowMs: number): Promise<{ invoice: NamedInvoice } | Record<string, unknown>> {
  const open = await loadOpenInvoicesWithNames(admin, ctx);
  const found = matchInvoices(open, input);
  const today = todayIn(ctx, nowMs);
  if (found.length === 0) return { ok: false, reason: "No open invoice matches that. Ask who (or which invoice) they mean.", open_invoices: choices(open, today) };
  if (found.length > 1) return { ok: false, reason: "More than one open invoice matches - ask which one.", matches: choices(found, today) };
  return { invoice: found[0] };
}

function fit(code: number | null, summary: string, kind: string, short: string): string {
  const line = `#${code ?? "?"} ${summary} ${inlineReplyLine(kind, code)}`;
  return line.length <= MAX_TELL_OWNER ? line : `#${code ?? "?"} ${short} ${inlineReplyLine(kind, code)}`;
}

// ── who_owes_me ───────────────────────────────────────────────────────────────

async function whoOwesMe(state: ToolRunState): Promise<Record<string, unknown>> {
  const ctx = await enabledCtx(state);
  if ("error" in ctx) return ctx;
  const today = todayIn(ctx, state.nowMs);
  const aging = agingSummary(await loadOpenInvoicesWithNames(state.admin, ctx), today);
  return {
    outstanding: ownerMoney(aging.outstandingCents),
    open_invoices: aging.openCount,
    overdue: ownerMoney(aging.overdueCents),
    overdue_invoices: aging.overdueCount,
    aging_days: Object.fromEntries(AGING_BUCKETS.map((b) => [b, { owing: ownerMoney(aging.buckets[b].cents), invoices: aging.buckets[b].count }])),
    top_owing: aging.top.map((l) => ({ customer: l.customer, invoice: l.invoiceNumber, owing: ownerMoney(l.owingCents), days_late: l.daysOverdue })),
    note: "0-30 includes invoices not due yet.",
  };
}

// ── cash_snapshot ─────────────────────────────────────────────────────────────

async function cashSnapshotTool(state: ToolRunState): Promise<Record<string, unknown>> {
  const ctx = await enabledCtx(state);
  if ("error" in ctx) return ctx;
  const today = todayIn(ctx, state.nowMs);
  const [open, inputs] = await Promise.all([loadOpenInvoicesWithNames(state.admin, ctx), loadCashInputs(state.admin, ctx, state.nowMs)]);
  const snap = cashSnapshot(inputs, agingSummary(open, today), state.nowMs, ctx.timeZone);
  return {
    collected_this_week: ownerMoney(snap.collectedWeekCents),
    collected_this_month: ownerMoney(snap.collectedMonthCents),
    outstanding: ownerMoney(snap.outstandingCents),
    overdue: ownerMoney(snap.overdueCents),
    overdue_invoices: snap.overdueCount,
    deposits_expected: ownerMoney(snap.depositsExpectedCents),
    approved_quotes_waiting_on_deposit: snap.depositsExpectedCount,
    week_from: shortDate(snap.weekStart),
    month_from: shortDate(snap.monthStart),
  };
}

// ── record_offline_payment ────────────────────────────────────────────────────

async function recordOfflinePayment(state: ToolRunState, input: Input): Promise<Record<string, unknown>> {
  const ctx = await enabledCtx(state);
  if ("error" in ctx) return ctx;
  const amountCents = dollarsToCents(input.amount);
  if (!amountCents) return { error: "How much did they pay? (a dollar amount)" };
  const method = str(input.method) ?? "other";
  if (!(method in PAYMENT_METHODS)) return { error: "Method must be etransfer, cheque, cash, card or other." };
  const picked = await pickInvoice(state.admin, ctx, input, state.nowMs);
  if (!("invoice" in picked)) return picked;
  const invoice = picked.invoice as NamedInvoice;
  const owing = owingCents(invoice);
  if (amountCents > owing) return { ok: false, reason: `That's more than the ${ownerMoney(owing)} owing on ${invoice.invoice_number ?? "that invoice"} - check the amount.` };
  const today = todayIn(ctx, state.nowMs);
  const receivedOn = str(input.received_on);
  if (receivedOn && (!isDateKey(receivedOn) || receivedOn > today)) return { error: "received_on must be a past date (YYYY-MM-DD)." };
  const existing = await pendingApprovalFor(state.admin, ctx.companyId, KIND_RECORD_PAYMENT, invoice.id);
  if (existing) return { ok: false, reason: `Already waiting on the owner: #${existing.short_code ?? "?"} for that invoice. Reply Y ${existing.short_code ?? ""} or N ${existing.short_code ?? ""} to it first.` };

  const reference = str(input.reference) ? clip(str(input.reference)!, 60) : null;
  const left = owing - amountCents;
  const when = receivedOn && receivedOn !== today ? ` received ${shortDate(receivedOn)}` : "";
  const label = PAYMENT_METHODS[method];
  const inv = invoice.invoice_number ? ` on ${invoice.invoice_number}` : "";
  const summary = `Record ${ownerMoney(amountCents)} ${label} from ${invoice.customer}${inv}${when}${reference ? ` (ref ${reference})` : ""}? ${left > 0 ? `${ownerMoney(left)} will still be owing.` : "That pays it in full."}`;
  const created = await createBookkeeperApproval(
    state.admin,
    {
      organizationId: ctx.organizationId,
      companyId: ctx.companyId,
      contactId: invoice.contact_id,
      kind: KIND_RECORD_PAYMENT,
      summary,
      payload: {
        invoiceId: invoice.id,
        customerName: invoice.customer,
        amountCents,
        method,
        reference,
        receivedAt: receivedOn ? new Date(localWallTimeToUtcMs(receivedOn, 12, 0, ctx.timeZone)).toISOString() : null,
      },
      inlineTo: state.ownerPhone,
    },
    state.nowMs,
  );
  return { ok: true, approval_created: true, tell_owner: fit(created.shortCode, summary, KIND_RECORD_PAYMENT, `Record ${ownerMoney(amountCents)} from ${invoice.customer}?`) };
}

// ── remind_now ────────────────────────────────────────────────────────────────

async function remindNow(state: ToolRunState, input: Input): Promise<Record<string, unknown>> {
  const ctx = await enabledCtx(state);
  if ("error" in ctx) return ctx;
  const picked = await pickInvoice(state.admin, ctx, input, state.nowMs);
  if (!("invoice" in picked)) return picked;
  const invoice = picked.invoice as NamedInvoice;
  const contact = await loadContact(state.admin, ctx, invoice.contact_id);
  if (!contact?.phone) return { ok: false, reason: `${invoice.customer} has no mobile number on file.` };
  const consent = checkConsent(reminderConsent(contact, invoice), "sms", state.nowMs);
  if (!consent.ok) return { ok: false, reason: consent.reason === "opted_out" ? `${invoice.customer} has opted out of texts.` : `${invoice.customer} hasn't agreed to texts, so I can't text them.` };
  const existing = await pendingApprovalFor(state.admin, ctx.companyId, KIND_SEND_REMINDER, invoice.id);
  if (existing) return { ok: false, reason: `Already waiting on the owner: #${existing.short_code ?? "?"} for that reminder.` };

  const today = todayIn(ctx, state.nowMs);
  const rInput = reminderInput(ctx, invoice, contact, today);
  const text = reminderText(rInput, toneForDays(rInput.daysOverdue));
  const name = fullNameOf(contact);
  const phone = prettyPhone(contact.phone);
  const late = rInput.daysOverdue > 0 ? `, ${rInput.daysOverdue} days late` : ", not due yet";
  const summary = `Text ${name}${phone && phone !== name ? ` (${phone})` : ""} about ${invoice.invoice_number ?? "their invoice"} (${ownerMoney(rInput.owingCents)}${late})? They'll get exactly: "${text}"`;
  const created = await createBookkeeperApproval(
    state.admin,
    {
      organizationId: ctx.organizationId,
      companyId: ctx.companyId,
      contactId: contact.id,
      kind: KIND_SEND_REMINDER,
      summary,
      payload: { invoiceId: invoice.id, contactId: contact.id, customerName: name, text, balanceCents: rInput.owingCents, daysOverdue: rInput.daysOverdue },
      inlineTo: state.ownerPhone,
    },
    state.nowMs,
  );
  return { ok: true, approval_created: true, tell_owner: fit(created.shortCode, summary, KIND_SEND_REMINDER, `Text ${contact.first_name ?? name}: "${text}"`) };
}

// ── The tools ─────────────────────────────────────────────────────────────────

const invoiceRef = {
  customer: { type: "string", description: "The customer's name (or part of it)." },
  invoice_number: { type: "string", description: "The invoice number, e.g. INV-2026-0012, if the owner gave one." },
  invoice_id: { type: "string", description: "An invoice_id from an earlier tool result." },
};

export const bookkeeperOwnerTools: RoleOwnerTool[] = [
  {
    tool: {
      name: "who_owes_me",
      description: "Money owed to the business: total outstanding and overdue, aging buckets (0-30, 31-60, 61-90, 90+ days late) and the top 5 owing.",
      input_schema: { type: "object", properties: {} },
    },
    run: (state) => whoOwesMe(state),
  },
  {
    tool: {
      name: "cash_snapshot",
      description: "Cash picture: collected this week and this month (invoice payments + quote deposits), outstanding, overdue, and deposits expected on approved quotes.",
      input_schema: { type: "object", properties: {} },
    },
    run: (state) => cashSnapshotTool(state),
  },
  {
    tool: {
      name: "record_offline_payment",
      description:
        "The owner says a customer paid outside the pay page (e-transfer, cheque, cash, card on a terminal). Creates an approval; nothing is recorded until the owner replies Y. Reply with the returned tell_owner text exactly.",
      input_schema: {
        type: "object",
        properties: {
          ...invoiceRef,
          amount: { type: "number", description: "Dollars received, e.g. 500 or 1240.50." },
          method: { type: "string", enum: ["etransfer", "cheque", "cash", "card", "other"] },
          received_on: { type: "string", description: "YYYY-MM-DD if not today." },
          reference: { type: "string", description: "Cheque number / e-transfer reference, if given." },
        },
        required: ["amount", "method"],
      },
    },
    run: (state, input) => recordOfflinePayment(state, input),
  },
  {
    tool: {
      name: "remind_now",
      description:
        "The owner wants a customer reminded about an unpaid invoice now. Creates an approval showing the exact text; nothing is sent until the owner replies Y. Reply with the returned tell_owner text exactly.",
      input_schema: { type: "object", properties: invoiceRef },
    },
    run: (state, input) => remindNow(state, input),
  },
];
