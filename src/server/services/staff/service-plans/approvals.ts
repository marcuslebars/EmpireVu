/**
 * The executors for plan_signup and plan_renewals (kinds and creation: approval-kinds.ts).
 *
 * plan_signup
 *   Y        pending_owner → active: term from today, visits laid on the series, the customer gets
 *            a confirmation text (annual plans: with their first-year invoice link).
 *   N        cancelled; a customer who signed up themselves is told the owner will be in touch.
 *   expiry   same as N, and the owner gets a text (a customer was waiting).
 * plan_renewals
 *   Y        each plan in the batch → renewal_due + its next-term visits on the calendar + the
 *            customer's own renewal link by text.
 *   N        no texts; those plans lapse 14 days after they end unless the customer pays.
 *   expiry   nothing sent; next week's batch asks again.
 *
 * A note ("Y 12 but …") is never acted on: nothing is done and the same question comes back
 * under a fresh code. Idempotent: the agreement is claimed (decision_claimed_at / per-agreement
 * renewal_texted_at, conditional on the approval id) before anything is sent.
 */
import { addDays, localDate } from "@/server/services/booking-windows";
import { replyInstruction } from "@/server/services/front-desk/approval-text";
import type { AdminClient, ApprovalDecision, ExecuteResult, OwnerApprovalRow } from "@/server/services/front-desk/contracts";
import { isQuietHours } from "@/server/services/owner-channel/common";
import { addNextTermVisits, askOwnerToStart, cancelAgreement, contactName, defaultPlanDeps, loadAgreement, newRenewalToken, startAgreement, type PlanDeps } from "./agreements";
import { createPlanApproval, PLAN_RENEWALS_KIND, PLAN_SIGNUP_KIND, smsDecider, supersedeApproval } from "./approval-kinds";
import type { IssuedInvoice } from "./billing";
import type { Db, ServiceAgreementRow } from "./db-types";
import { publishedSlug, renewalUrlFor } from "./links";
import { inCustomerWindow, loadContact, queueAndSend } from "./messages";
import { loadPlan } from "./plans";
import { dayText, longDate, money, termEndFor } from "./schedule";
import { loadPlanCompany, type PlanCompany } from "./settings";
import { declinedText, firstNameOf, renewalText } from "./texts";

const code = (approval: OwnerApprovalRow) => `#${approval.short_code ?? "?"}`;

/** Re-ask the same question under a fresh code (a note we can't act on). */
async function reAsk(admin: AdminClient, approval: OwnerApprovalRow, decision: ApprovalDecision, nowMs: number, deps: PlanDeps): Promise<{ id: string; shortCode: number | null }> {
  const kind = approval.kind === PLAN_RENEWALS_KIND ? PLAN_RENEWALS_KIND : PLAN_SIGNUP_KIND;
  return createPlanApproval(
    admin,
    { organizationId: approval.organization_id, companyId: approval.company_id, contactId: approval.contact_id, kind, summary: approval.summary, payload: approval.payload, askedInlineTo: smsDecider(decision) },
    nowMs,
    deps.approvals,
  );
}

// ── plan_signup ─────────────────────────────────────────────────────────────

export async function executePlanSignup(admin: AdminClient, approval: OwnerApprovalRow, decision: ApprovalDecision, deps: PlanDeps = defaultPlanDeps, nowMs: number = Date.now()): Promise<ExecuteResult> {
  const db = admin as Db;
  const scope = { organizationId: approval.organization_id, companyId: approval.company_id };
  const agreementId = typeof approval.payload?.agreementId === "string" ? approval.payload.agreementId : "";
  const agreement = agreementId ? await loadAgreement(admin, scope, agreementId) : null;
  if (!agreement || agreement.approval_id !== approval.id) return { ok: false, message: `${code(approval)} isn't linked to a sign-up any more, so nothing was done.` };

  if (decision.approved && decision.ownerNote?.trim()) {
    if (agreement.status !== "pending_owner") return { ok: false, message: `${code(approval)}: nothing was done (that sign-up isn't waiting any more).` };
    const again = await reAsk(admin, approval, decision, nowMs, deps);
    const { data: moved } = await db.from("service_agreements").update({ approval_id: again.id }).eq("organization_id", scope.organizationId).eq("id", agreement.id).eq("approval_id", approval.id).select("id");
    if (((moved ?? []) as unknown[]).length === 0) {
      await supersedeApproval(admin, again.id);
      return { ok: false, message: `${code(approval)}: nothing was done.` };
    }
    return { ok: false, message: `Nothing done yet - #${approval.short_code ?? "?"} starts the plan exactly as shown (change the plan's price in Settings). ${replyInstruction(PLAN_SIGNUP_KIND, again.shortCode)}` };
  }

  // Claim the decision (a retried Y finds it taken).
  const { data: claim } = await db
    .from("service_agreements")
    .update({ decision_claimed_at: new Date(nowMs).toISOString() })
    .eq("organization_id", scope.organizationId)
    .eq("id", agreement.id)
    .eq("approval_id", approval.id)
    .is("decision_claimed_at", null)
    .select("id");
  if (((claim ?? []) as unknown[]).length === 0) return { ok: true, message: `${code(approval)} was already handled.` };

  const company = await loadPlanCompany(admin, scope.organizationId, scope.companyId);
  const contact = await loadContact(admin, scope.organizationId, agreement.contact_id);
  const who = contactName(contact, agreement.customer_name);
  const release = () => db.from("service_agreements").update({ decision_claimed_at: null }).eq("organization_id", scope.organizationId).eq("id", agreement.id).eq("approval_id", approval.id);

  if (decision.approved) {
    if (!company || !company.settings.enabled) {
      await release();
      return { ok: false, message: "Service plans are off for this business (Settings > AI front desk > Service plans), so nothing was started." };
    }
    if (agreement.status !== "pending_owner") return { ok: false, message: `${who}'s sign-up isn't waiting any more (${agreement.status.replace("_", " ")}), so nothing was done.` };
    let invoice: IssuedInvoice | null = null;
    if (agreement.billing === "annual" && agreement.contact_id) {
      const today = localDate(new Date(nowMs), company.timeZone);
      try {
        invoice = await deps.billing.issueTermInvoice(admin, {
          organizationId: scope.organizationId,
          companyId: scope.companyId,
          contactId: agreement.contact_id,
          title: `${agreement.plan_name} - service plan`,
          lineLabel: `${agreement.plan_name} - service plan, 12 months`,
          lineDescription: `From ${longDate(today)} to ${longDate(termEndFor(today))}.`,
          priceCents: agreement.price_cents,
          dueDate: addDays(today, 14),
          pauseReminders: false,
          internalNote: `Service plan (agreement ${agreement.id}), started by the owner's OK.`,
        });
      } catch (err) {
        await release();
        console.error("[service-plans] first-year invoice failed:", err instanceof Error ? err.message : err);
        return { ok: false, message: `Couldn't create ${who}'s first-year invoice, so the plan wasn't started. Try again from the app.` };
      }
    }
    const started = await startAgreement(admin, company, agreement, { nowMs, from: ["pending_owner"], invoice }, deps);
    if (!started.ok) return { ok: false, message: `${who}'s sign-up was already handled.` };
    const first = started.firstVisit ? `, first ${dayText(started.firstVisit)}` : "";
    const paid = invoice ? ` with their invoice (${money(invoice.totalCents)})` : "";
    return {
      ok: true,
      message: `Started ${who} on ${agreement.plan_name}: ${started.visits} visit${started.visits === 1 ? "" : "s"} booked${first}. ${started.texted ? `Texted them to confirm${paid}.` : "Couldn't text them (no number or they opted out)."}`,
      detail: { agreementId: agreement.id, invoiceId: invoice?.id ?? null },
    };
  }

  // N or expiry.
  const expired = decision.decidedVia === "expiry";
  if (company) {
    const cancelled = await cancelAgreement(admin, company, agreement, expired ? "no answer from the owner" : "owner said no", nowMs, deps);
    if (cancelled.ok && cancelled.agreement && agreement.source === "public") {
      const body = declinedText({ firstName: firstNameOf(contact?.first_name ?? agreement.customer_name), businessName: company.name, planName: agreement.plan_name });
      await queueAndSend(admin, { company, agreement: cancelled.agreement, kind: "declined", dedupeKey: agreement.id, body, nowMs }, deps.messages);
    }
    if (expired && agreement.source === "public" && company.ownerPhone && !isQuietHours(nowMs, company.timeZone)) {
      await deps.ownerSms(admin, {
        to: company.ownerPhone,
        organizationId: company.organizationId,
        companyId: company.companyId,
        platformBrand: company.platformBrand,
        body: `No answer on ${code(approval)} (${who}'s sign-up for ${agreement.plan_name}), so I told ${who} you'll be in touch.`,
      });
    }
  }
  if (expired) return { ok: true, message: `${code(approval)} expired: ${who} wasn't signed up.` };
  return { ok: true, message: agreement.source === "public" ? `OK - ${who} isn't on ${agreement.plan_name}. I told them you'll be in touch.` : `OK - ${who} wasn't signed up.` };
}

// ── plan_renewals ───────────────────────────────────────────────────────────

/** Text one customer their renewal link (claimed per agreement). */
export async function sendRenewal(
  admin: AdminClient,
  company: PlanCompany,
  agreement: ServiceAgreementRow,
  approvalId: string,
  nowMs: number,
  deps: PlanDeps = defaultPlanDeps,
): Promise<{ sent: boolean; priceCents: number; reason?: string }> {
  const db = admin as Db;
  const plan = await loadPlan(admin, company, agreement.plan_id);
  const priceCents = plan?.active ? plan.price_cents : agreement.price_cents;
  const token = agreement.renewal_token ?? newRenewalToken();
  const { data: claimed } = await db
    .from("service_agreements")
    .update({ status: "renewal_due", renewal_token: token, renewal_price_cents: priceCents, renewal_texted_at: new Date(nowMs).toISOString() })
    .eq("organization_id", company.organizationId)
    .eq("company_id", company.companyId)
    .eq("id", agreement.id)
    .eq("renewal_approval_id", approvalId)
    .is("renewal_texted_at", null)
    .in("status", ["active", "renewal_due"])
    .select("*");
  const row = ((claimed ?? []) as ServiceAgreementRow[])[0];
  if (!row || !row.term_end) return { sent: false, priceCents, reason: "already" };
  const slug = await publishedSlug(admin, company).catch(() => null);
  let link: string | null = slug ? renewalUrlFor(slug, company, token) : null;
  if (!link && row.billing === "annual" && row.contact_id) {
    // No website for the renewal page: the renewal invoice's own pay page instead.
    try {
      const start = addDays(row.term_end, 1);
      const invoice = await deps.billing.issueTermInvoice(admin, {
        organizationId: company.organizationId,
        companyId: company.companyId,
        contactId: row.contact_id,
        title: `${row.plan_name} - service plan renewal`,
        lineLabel: `${row.plan_name} - service plan, 12 months`,
        lineDescription: `From ${longDate(start)} to ${longDate(termEndFor(start))}.`,
        priceCents,
        dueDate: row.term_end,
        pauseReminders: true,
        internalNote: `Service plan renewal (agreement ${row.id}).`,
      });
      await db.from("service_agreements").update({ pending_invoice_id: invoice.id }).eq("organization_id", company.organizationId).eq("id", row.id);
      link = invoice.url;
    } catch (err) {
      console.error("[service-plans] renewal invoice failed:", err instanceof Error ? err.message : err);
    }
  }
  if (!link) {
    await db.from("service_agreements").update({ renewal_texted_at: null }).eq("organization_id", company.organizationId).eq("id", row.id);
    return { sent: false, priceCents, reason: "no renewal page (the website isn't live)" };
  }
  const nextDates = await addNextTermVisits(admin, company, row, nowMs);
  const contact = await loadContact(admin, company.organizationId, row.contact_id);
  const body = renewalText({
    firstName: firstNameOf(contact?.first_name ?? row.customer_name),
    businessName: company.name,
    planName: row.plan_name,
    billing: row.billing,
    priceCents,
    renewsOn: addDays(row.term_end, 1),
    nextVisit: nextDates[0] ?? null,
    planMonths: row.visit_months,
    link,
  });
  const outcome = await queueAndSend(admin, { company, agreement: row, kind: "renewal", dedupeKey: `${row.id}:${row.term_end}`, body, nowMs }, deps.messages);
  return { sent: outcome === "sent" || outcome === "queued" || outcome === "duplicate", priceCents, reason: outcome };
}

export async function executePlanRenewals(admin: AdminClient, approval: OwnerApprovalRow, decision: ApprovalDecision, deps: PlanDeps = defaultPlanDeps, nowMs: number = Date.now()): Promise<ExecuteResult> {
  const db = admin as Db;
  const scope = { organizationId: approval.organization_id, companyId: approval.company_id };
  const ids = Array.isArray(approval.payload?.agreementIds) ? (approval.payload.agreementIds as unknown[]).filter((v): v is string => typeof v === "string") : [];
  const { data } = ids.length
    ? await db.from("service_agreements").select("*").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).in("id", ids)
    : { data: [] };
  const rows = ((data ?? []) as ServiceAgreementRow[]).filter((r) => r.renewal_approval_id === approval.id);
  if (rows.length === 0) return { ok: false, message: `${code(approval)} isn't linked to any plans any more, so nothing was sent.` };

  if (decision.approved && decision.ownerNote?.trim()) {
    const again = await reAsk(admin, approval, decision, nowMs, deps);
    await db.from("service_agreements").update({ renewal_approval_id: again.id }).eq("organization_id", scope.organizationId).eq("renewal_approval_id", approval.id);
    return { ok: false, message: `Nothing sent yet - #${approval.short_code ?? "?"} goes to everyone listed (cancel a plan in Settings to leave it out). ${replyInstruction(PLAN_RENEWALS_KIND, again.shortCode)}` };
  }

  if (!decision.approved) {
    if (decision.decidedVia === "expiry") {
      // Asked again with next week's batch.
      await db.from("service_agreements").update({ renewal_approval_id: null, renewal_asked_at: null }).eq("organization_id", scope.organizationId).eq("renewal_approval_id", approval.id).is("renewal_texted_at", null);
      return { ok: true, message: `${code(approval)} expired: no renewal texts went out. I'll ask again next week.` };
    }
    await db.from("service_agreements").update({ renewal_declined_at: new Date(nowMs).toISOString() }).eq("organization_id", scope.organizationId).eq("renewal_approval_id", approval.id).is("renewal_texted_at", null);
    return { ok: true, message: `OK - no renewal texts. Those plans lapse 14 days after they end unless the customer pays you.` };
  }

  const company = await loadPlanCompany(admin, scope.organizationId, scope.companyId);
  if (!company || !company.settings.enabled) return { ok: false, message: "Service plans are off for this business, so no renewal texts went out." };
  let sent = 0;
  let total = 0;
  const problems: string[] = [];
  for (const row of rows) {
    const result = await sendRenewal(admin, company, row, approval.id, nowMs, deps);
    if (result.sent) {
      sent += 1;
      if (row.billing === "annual") total += result.priceCents;
    } else if (result.reason && result.reason !== "already") {
      const contact = await loadContact(admin, company.organizationId, row.contact_id);
      problems.push(`${contactName(contact, row.customer_name)} (${result.reason})`);
    }
  }
  const late = inCustomerWindow(nowMs, company.timeZone) ? "" : " They go out at 9am.";
  const head = sent ? `Texted ${sent} customer${sent === 1 ? "" : "s"} their renewal link${sent === 1 ? "" : "s"}${total ? ` (${money(total)})` : ""}.${late}` : "No renewal texts went out.";
  return { ok: sent > 0 || problems.length === 0, message: `${head}${problems.length ? ` Not sent: ${problems.slice(0, 3).join("; ")}.` : ""}`.slice(0, 400), detail: { sent } };
}

