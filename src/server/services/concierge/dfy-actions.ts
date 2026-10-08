// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION (service role): concierge console — done-for-you actions.
// Registered into the concierge registry (services/concierge/actions.ts), so each one runs
// only through runConciergeAction: requireOperator first (404 for everyone else), strict zod
// input, ONE org named by the operator + its own company (resolveAccount), and an
// operator_actions audit row written BEFORE it runs. Every helper called here filters by that
// organization_id + company id. docs/done-for-you.md → "Concierge console".
//
// Loaded by services/concierge/register-all.ts (what the concierge routes import) — never
// import this module from actions.ts itself (registration order / import cycle).
// ─────────────────────────────────────────────────────────────────────────────
import { isCrankleadsTier } from "@/server/services/crankleads/config";
import { ValidationError } from "@/server/organizations/context";
import { emptySchema, registerConciergeAction } from "@/server/services/concierge/actions";
import { enrichCompany } from "@/server/services/dfy/enrich";
import { resendSetupIntake } from "@/server/services/dfy/intake";
import { ensureDfyNumber } from "@/server/services/dfy/numbers";
import { advanceDoneForYou, resendForwardingText, type ForwardingTextOutcome } from "@/server/services/dfy/orchestrator";
import { ensureProgress, patchProgress } from "@/server/services/dfy/progress";
import { generateSite, setSiteStatus } from "@/server/services/dfy/site-generator";
import { siteUrl } from "@/server/services/dfy/site-url";

/** Names of the done-for-you actions (tests + the console's confirm copy). */
export const DFY_CONCIERGE_ACTIONS = [
  "resend_quick_setup_link",
  "rerun_business_lookup",
  "build_website",
  "unpublish_website",
  "send_forwarding_text",
  "retry_dfy_number",
  "run_switch_on",
] as const;

registerConciergeAction({
  name: "resend_quick_setup_link",
  label: "Resend quick-setup link",
  schema: emptySchema,
  async run(ctx) {
    const outcome = await resendSetupIntake(ctx.admin, { organizationId: ctx.organizationId, companyId: ctx.companyId });
    if (outcome.status !== "sent") {
      throw new ValidationError(`Couldn't send it${outcome.status === "failed" ? `: ${outcome.error}` : ""}.`);
    }
    const how = [outcome.sms ? "text" : null, outcome.email ? "email" : null].filter(Boolean).join(" + ");
    return { message: `Quick-setup link sent (${how || "nothing"}).`, result: { url: outcome.url }, audit: { sms: outcome.sms, email: outcome.email } };
  },
});

registerConciergeAction({
  name: "rerun_business_lookup",
  label: "Re-run business lookup",
  schema: emptySchema,
  async run(ctx) {
    // enrichCompany reads the intake answers + the company's own row (by company id) and
    // writes only that company; it throws when there is no quick-setup answer to work from.
    const summary = await enrichCompany(ctx.admin, ctx.companyId);
    // Mark the intake enriched (a failed one recovers): switch-on proceeds, and a page built
    // before this refresh is rebuilt once by the orchestrator (enriched_at > generated_at).
    const nowIso = new Date(ctx.nowMs).toISOString();
    const { error } = await ctx.admin
      .from("setup_intakes")
      .update({ status: "enriched", enriched_at: nowIso, last_error: null, updated_at: nowIso })
      .eq("organization_id", ctx.organizationId)
      .eq("company_id", ctx.companyId);
    if (error) throw new Error(`intake status update failed: ${error.message}`);
    return {
      message: "Business lookup finished — facts below are refreshed.",
      audit: { summary: JSON.parse(JSON.stringify(summary ?? null)) as unknown },
    };
  },
});

registerConciergeAction({
  name: "build_website",
  label: "Build / rebuild website",
  schema: emptySchema,
  async run(ctx) {
    const built = await generateSite(ctx.admin, ctx.companyId, { publish: true });
    return {
      message: `Page ${built.created ? "built" : "rebuilt"} and published: ${built.url}`,
      result: { url: built.url, slug: built.site.slug },
      audit: { slug: built.site.slug, url: built.url, created: built.created, copySource: built.content.copySource },
    };
  },
});

registerConciergeAction({
  name: "unpublish_website",
  label: "Unpublish website",
  schema: emptySchema,
  async run(ctx) {
    const site = await setSiteStatus(ctx.admin, ctx.companyId, "unpublished", { now: new Date(ctx.nowMs) });
    return { message: "Page unpublished — the link now shows not found.", audit: { slug: site.slug, url: siteUrl(site.slug, "crankleads") } };
  },
});

const FORWARDING_TEXT_ERRORS: Record<Exclude<ForwardingTextOutcome, "sent">, string> = {
  no_number: "There's no text-back / AI number yet — retry the number first.",
  verified: "Forwarding already works for them — nothing to send.",
  not_switched_on: "Setup hasn't been switched on yet — run switch-on first.",
  quiet_hours: "It's outside 8am–9pm their time — try again in the morning.",
  not_crankleads: "This isn't an active CrankLeads account.",
};

registerConciergeAction({
  name: "send_forwarding_text",
  label: "Send forwarding text",
  schema: emptySchema,
  async run(ctx) {
    const outcome = await resendForwardingText(ctx.admin, ctx.companyId, { now: () => ctx.nowMs });
    if (outcome !== "sent") throw new ValidationError(FORWARDING_TEXT_ERRORS[outcome]);
    return { message: "Forwarding text + email sent.", audit: { outcome } };
  },
});

registerConciergeAction({
  name: "retry_dfy_number",
  label: "Retry text-back number",
  schema: emptySchema,
  async run(ctx) {
    const rawTier = ctx.org.crankleads_tier ?? ctx.purchase?.tier ?? null;
    if (!isCrankleadsTier(rawTier)) throw new ValidationError("This account has no CrankLeads plan.");
    const row = await ensureProgress(ctx.admin, ctx.organizationId, ctx.companyId);
    const before = { flaggedAt: row.number_flagged_at, attempts: row.number_attempts, lastError: row.number_last_error };
    // Clear the flag + attempt count so the purchase runs again now (with its usual area-code order).
    await patchProgress(ctx.admin, row, { number_flagged_at: null, number_attempts: 0, number_last_attempt_at: null });
    const outcome = await ensureDfyNumber(
      ctx.admin,
      {
        organizationId: ctx.organizationId,
        companyId: ctx.companyId,
        tier: rawTier,
        ownerPhone: ctx.purchase?.owner_phone ?? ctx.company.owner_phone_e164,
      },
      { now: () => ctx.nowMs },
    );
    if (outcome.status !== "ready") {
      throw new ValidationError(`Still couldn't get a number: ${"error" in outcome && outcome.error ? outcome.error : outcome.status}`);
    }
    return {
      message: `${outcome.purchasedNow ? "Number bought" : "Number already there"}: ${outcome.phoneNumber}`,
      result: { phoneNumber: outcome.phoneNumber },
      audit: { before, after: { phoneNumber: outcome.phoneNumber, purchasedNow: outcome.purchasedNow } },
    };
  },
});

registerConciergeAction({
  name: "run_switch_on",
  label: "Run switch-on now",
  schema: emptySchema,
  async run(ctx) {
    const result = await advanceDoneForYou(ctx.admin, ctx.companyId, { now: () => ctx.nowMs }, { force: true });
    if (result.error) throw new Error(result.error);
    const what = result.skipped ? `nothing to do (${result.skipped})` : result.steps.join(", ") || "nothing new";
    return { message: `Switch-on ran: ${what}.`, result, audit: { steps: result.steps, skipped: result.skipped ?? null } };
  },
});
