/**
 * The Bookkeeper's tools for the customer-facing SMS agent. Pinned to the conversation's company
 * and contact (the model can't pick another customer's invoice): my_invoices, promise_to_pay,
 * request_payment_plan (→ a payment_plan approval; the plan only starts on the owner's Y).
 */
import { z } from "zod";

import { recordInvoiceEvent } from "@/server/services/invoices/common";
import type { AgentTool, TurnState } from "@/server/services/sms-agent/tools";
import { createBookkeeperApproval, KIND_PAYMENT_PLAN } from "./approvals";
import { ensureCollections, loadCompanyCtx, openInvoicesForContact, owingCents, payLink, todayIn, type CompanyCtx } from "./context";
import type { BookkeeperInvoice, Db, Instalment } from "./db-types";
import { addDays, addMonths, clip, dayDate, daysBetween, fullNameOf, isDateKey, localParts, money, shortDate } from "./format";
import { planDates, planShape } from "./texts";
import { prettyPhone } from "@/server/services/front-desk/approval-text";

export const PROMISE_MAX_DAYS = 30;
export const PLAN_MIN_PAYMENTS = 2;
export const PLAN_MAX_PAYMENTS = 6;
export const PLAN_MAX_SPAN_DAYS = 183;

const OFF = { ok: false, error: "Invoices aren't handled by text for this business. If they ask about a bill, use hand_off_to_owner." };

async function bookkeeperCtx(state: TurnState): Promise<CompanyCtx | null> {
  const ctx = await loadCompanyCtx(state.admin, state.facts.organizationId, state.facts.companyId);
  return ctx && ctx.settings.enabled ? ctx : null;
}

function ownerName(state: TurnState): string {
  return state.facts.ownerFirstName ?? "the owner";
}

function matchNumber(invoices: BookkeeperInvoice[], number: string | undefined): BookkeeperInvoice[] {
  if (!number?.trim()) return invoices;
  const n = number.trim().toLowerCase().replace(/^#/, "");
  return invoices.filter((i) => (i.invoice_number ?? "").toLowerCase() === n || (i.invoice_number ?? "").toLowerCase().endsWith(n));
}

/** Equal instalments (the leftover cents on the last one), weekly / every 2 weeks / monthly. PURE. */
export function buildInstalments(owingCentsTotal: number, payments: number, frequency: "weekly" | "every_2_weeks" | "monthly", firstDate: string): Instalment[] {
  const base = Math.floor(owingCentsTotal / payments);
  const out: Instalment[] = [];
  for (let i = 0; i < payments; i++) {
    const dueDate = frequency === "monthly" ? addMonths(firstDate, i) : addDays(firstDate, i * (frequency === "weekly" ? 7 : 14));
    out.push({ n: i + 1, dueDate, amountCents: i === payments - 1 ? owingCentsTotal - base * (payments - 1) : base });
  }
  return out;
}

const myInvoices: AgentTool<{ send_link?: boolean }> = {
  name: "my_invoices",
  description:
    "This customer's unpaid invoices with what's owing and when each was due. Use when they ask what they owe, about their bill or invoice, or for the pay link (send_link: true puts the pay link in your reply). Only state amounts this tool returned.",
  inputSchema: {
    type: "object",
    properties: { send_link: { type: "boolean", description: "Include the pay link(s) in your reply." } },
    additionalProperties: false,
  },
  parse: z.object({ send_link: z.boolean().optional() }),
  async run(state, input) {
    const ctx = await bookkeeperCtx(state);
    if (!ctx) return OFF;
    const today = todayIn(ctx, state.services.now().getTime());
    const invoices = await openInvoicesForContact(state.admin, ctx, state.contact.id);
    if (invoices.length === 0) {
      return { ok: true, invoices: [], note: "No unpaid invoices on file for this customer. If they think they owe something, or say they already paid, use hand_off_to_owner." };
    }
    let total = 0;
    const rows = invoices.map((inv) => {
      const owing = owingCents(inv);
      total += owing;
      state.effects.allowedAmountsCents.add(owing);
      const link = payLink(ctx, inv);
      if (input.send_link && state.effects.links.length < 3 && !state.effects.links.includes(link)) state.effects.links.push(link);
      return {
        invoice: inv.invoice_number,
        owing: money(owing),
        due: inv.due_date ? shortDate(inv.due_date) : null,
        days_past_due: inv.due_date ? Math.max(0, daysBetween(inv.due_date, today)) : 0,
        ...(input.send_link ? { pay_link: link } : {}),
      };
    });
    state.effects.allowedAmountsCents.add(total);
    return {
      ok: true,
      invoices: rows,
      total_owing: money(total),
      tell_customer: input.send_link ? "Give the amount owing and say they can pay with the link (it's added to your reply)." : "Tell them what's owing; offer to text the pay link.",
    };
  },
};

const promiseToPay: AgentTool<{ date: string; invoice_number?: string }> = {
  name: "promise_to_pay",
  description: `The customer says when they'll pay ("Friday", "the 15th"). Records the date (today to ${PROMISE_MAX_DAYS} days out) and pauses payment reminders until the day after. For longer, offer request_payment_plan instead.`,
  inputSchema: {
    type: "object",
    properties: {
      date: { type: "string", description: "YYYY-MM-DD (local) they said they'll pay by." },
      invoice_number: { type: "string", description: "Only if they named one invoice of several." },
    },
    required: ["date"],
    additionalProperties: false,
  },
  parse: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), invoice_number: z.string().max(40).optional() }),
  async run(state, input) {
    const ctx = await bookkeeperCtx(state);
    if (!ctx) return OFF;
    const nowMs = state.services.now().getTime();
    const today = todayIn(ctx, nowMs);
    if (!isDateKey(input.date)) return { ok: false, error: "That isn't a real date - ask for the date they'll pay." };
    const ahead = daysBetween(today, input.date);
    if (!Number.isFinite(ahead) || ahead < 0) return { ok: false, error: "That date is in the past - ask for the date they'll pay." };
    if (ahead > PROMISE_MAX_DAYS) return { ok: false, error: `That's more than ${PROMISE_MAX_DAYS} days out - offer a payment plan (request_payment_plan) or hand off to the owner.` };
    const targets = matchNumber(await openInvoicesForContact(state.admin, ctx, state.contact.id), input.invoice_number);
    if (targets.length === 0) return { ok: false, error: "No unpaid invoice matches - check with my_invoices." };
    const db = state.admin as Db;
    const rows = await Promise.all(targets.map((inv) => ensureCollections(state.admin, inv)));
    // One promise per invoice: a second date (or one after a missed promise) is the owner's call,
    // so reminders can't be pushed back forever.
    const earlier = rows.find((r) => r.promise_status === "missed" || (r.promise_status === "open" && r.promise_date));
    if (earlier) {
      const missed = earlier.promise_status === "missed" || (earlier.promise_date ?? "") < today;
      return {
        ok: false,
        error: missed
          ? `They already promised to pay by ${shortDate(earlier.promise_date)} and that date passed. Don't record a new date - use hand_off_to_owner.`
          : `They already promised to pay by ${shortDate(earlier.promise_date)}. To change that date, use hand_off_to_owner.`,
      };
    }
    const recorded: string[] = [];
    for (const [i, inv] of targets.entries()) {
      const row = rows[i];
      // A payment plan's own schedule wins over a promise.
      if (row.hold_reason === "payment_plan" && row.hold_until && row.hold_until >= today) continue;
      // Never hold past 30 days from when the promise was first recorded.
      const recordedAt = row.promise_recorded_at ?? new Date(nowMs).toISOString();
      const cap = addDays(localParts(Date.parse(recordedAt), ctx.timeZone).date, PROMISE_MAX_DAYS);
      const holdUntil = input.date < cap ? input.date : cap;
      const { error } = await db
        .from("invoice_collections")
        .update({ hold_until: holdUntil, hold_reason: "promise", promise_date: input.date, promise_recorded_at: recordedAt, promise_status: "open" })
        .eq("organization_id", ctx.organizationId)
        .eq("invoice_id", inv.id);
      if (error) return { ok: false, error: "That didn't save. Don't tell them it's recorded - say you'll pass it on, and use hand_off_to_owner." };
      await recordInvoiceEvent(state.admin as never, { organizationId: ctx.organizationId, invoiceId: inv.id, eventType: "promise_to_pay", metadata: { date: input.date, via: "sms_agent" } });
      recorded.push(inv.invoice_number ?? inv.id);
    }
    state.effects.collected.promise_to_pay = input.date;
    return {
      ok: true,
      recorded_for: recorded,
      tell_customer: `Thank them and confirm ${dayDate(input.date)}. Say there'll be no payment reminders before then.`,
    };
  },
};

const requestPaymentPlan: AgentTool<{ payments: number; frequency: "weekly" | "every_2_weeks" | "monthly"; first_payment_date?: string; invoice_number?: string }> = {
  name: "request_payment_plan",
  description: `The customer can't pay in full and wants to pay in instalments. Asks the owner to OK a plan (${PLAN_MIN_PAYMENTS}-${PLAN_MAX_PAYMENTS} equal payments, weekly / every 2 weeks / monthly). Never promise the plan - say you're checking.`,
  inputSchema: {
    type: "object",
    properties: {
      payments: { type: "integer", minimum: PLAN_MIN_PAYMENTS, maximum: PLAN_MAX_PAYMENTS, description: "How many payments." },
      frequency: { type: "string", enum: ["weekly", "every_2_weeks", "monthly"] },
      first_payment_date: { type: "string", description: "YYYY-MM-DD of the first payment (default: a week from today)." },
      invoice_number: { type: "string", description: "Which invoice, if they have more than one." },
    },
    required: ["payments", "frequency"],
    additionalProperties: false,
  },
  parse: z.object({
    payments: z.number().int().min(PLAN_MIN_PAYMENTS).max(PLAN_MAX_PAYMENTS),
    frequency: z.enum(["weekly", "every_2_weeks", "monthly"]),
    first_payment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    invoice_number: z.string().max(40).optional(),
  }),
  async run(state, input) {
    const ctx = await bookkeeperCtx(state);
    if (!ctx) return OFF;
    const nowMs = state.services.now().getTime();
    const today = todayIn(ctx, nowMs);
    const open = matchNumber(await openInvoicesForContact(state.admin, ctx, state.contact.id), input.invoice_number);
    if (open.length === 0) return { ok: false, error: "No unpaid invoice matches - check with my_invoices." };
    if (open.length > 1) return { ok: false, error: `They have ${open.length} unpaid invoices (${open.map((i) => i.invoice_number ?? "unnumbered").join(", ")}) - ask which one the plan is for.` };
    const invoice = open[0];
    const first = input.first_payment_date ?? addDays(today, 7);
    if (!isDateKey(first)) return { ok: false, error: "That first payment date isn't a real date." };
    const lead = daysBetween(today, first);
    if (lead < 0 || lead > PROMISE_MAX_DAYS) return { ok: false, error: `The first payment has to be between today and ${PROMISE_MAX_DAYS} days out.` };
    const owing = owingCents(invoice);
    const instalments = buildInstalments(owing, input.payments, input.frequency, first);
    if (daysBetween(today, instalments[instalments.length - 1].dueDate) > PLAN_MAX_SPAN_DAYS) return { ok: false, error: "That plan runs past 6 months - suggest fewer or more frequent payments, or hand off to the owner." };

    const db = state.admin as Db;
    const { data: active } = await db.from("payment_plans").select("id").eq("organization_id", ctx.organizationId).eq("invoice_id", invoice.id).eq("status", "active").limit(1);
    if (((active ?? []) as unknown[]).length > 0) return { ok: false, error: "They already have a payment plan on this invoice. If they want to change it, hand off to the owner." };
    const { data: waiting } = await db
      .from("owner_approvals")
      .select("id")
      .eq("company_id", ctx.companyId)
      .eq("contact_id", state.contact.id)
      .eq("kind", KIND_PAYMENT_PLAN)
      .eq("status", "pending")
      .limit(1);
    if (((waiting ?? []) as unknown[]).length > 0) {
      return { ok: true, already_waiting: true, tell_customer: `You're still waiting on ${ownerName(state)} about the plan - say you'll get back to them as soon as you hear.` };
    }

    const name = fullNameOf(state.contact);
    const phone = prettyPhone(state.contact.phone);
    const who = phone && phone !== name ? `${name} (${phone})` : name;
    const core = `${who} asks for a payment plan on ${invoice.invoice_number ?? "their invoice"} (${money(owing)} owing): ${planShape(instalments)} - ${planDates(instalments)}. Y sets it up, texts them the plan and reminds them before each payment.`;
    const room = 480 - core.length - 16;
    const summary = state.customerText?.trim() && room > 40 ? `${core} Their text: "${clip(state.customerText, Math.min(160, room))}"` : core;
    for (const i of instalments) state.effects.allowedAmountsCents.add(i.amountCents);
    const created = await createBookkeeperApproval(
      state.admin,
      {
        organizationId: ctx.organizationId,
        companyId: ctx.companyId,
        contactId: state.contact.id,
        conversationId: state.conversation.id,
        kind: KIND_PAYMENT_PLAN,
        summary,
        payload: { invoiceId: invoice.id, contactId: state.contact.id, customerName: name, instalments, balanceCents: owing, frequency: input.frequency },
      },
      nowMs,
    );
    state.effects.approvals.push({ id: created.id, shortCode: created.shortCode ?? 0, kind: KIND_PAYMENT_PLAN });
    state.effects.collected.approval_ids = [created.id];
    return {
      ok: true,
      approval_requested: true,
      plan_asked_for: planShape(instalments),
      tell_customer: `Tell them you're checking with ${ownerName(state)} about the plan and will get right back to them. Don't promise it.`,
    };
  },
};

export const bookkeeperAgentTools = [myInvoices, promiseToPay, requestPaymentPlan] as unknown as AgentTool<never>[];
