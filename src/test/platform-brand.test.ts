/**
 * Per-account platform brand (docs/crankleads-branding.md): the shared configs, host and org
 * resolution, the server's per-brand app origin, and the owner-facing copy that now follows
 * the org's brand.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { brandHelpArticle, HELP_ARTICLES } from "@/content/help/articles";
import { brandForHost, brandForOrg, platformBrand, PLATFORM_BRANDS, withProductName } from "@/lib/platform-brand";
import { helpSystemPrompt, HELP_SYSTEM_PROMPT } from "@/server/ai/help-assistant";
import { depositPaymentDoc, expenseDoc, paymentDoc } from "@/server/services/accounting/mapping";
import { checkoutBrandingFor } from "@/server/services/billing/checkout";
import { renderWelcomeEmail } from "@/server/services/crankleads/emails";
import { renderReminderEmail, renderLiveEmail, renderReminderSms } from "@/server/services/crankleads/followup-messages";
import { handoffAnswer, HANDOFF_ANSWER } from "@/server/services/help/assistant";
import { buildSupportEmail } from "@/server/services/help/support";
import { EMPTY_ACCOUNT_CONTEXT } from "@/server/services/help/account-context";
import { scorecardPlatformBrandName } from "@/server/services/monthly-scorecard/platform-brand";
import { invitationUrl, renderInvitationEmail } from "@/server/services/organization-invitations";
import { appBaseUrlFor, appHostFor, configuredAppBaseUrlFor } from "@/server/services/platform-brand";
import { appLinkForMissedCall, buildVoicemailOwnerAlert } from "@/server/services/twilio/missed-call";

const EMPIRE = /empire\s*vu/i;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("brandForHost", () => {
  it.each([
    ["app.crankleads.com", "crankleads"],
    ["APP.CrankLeads.com", "crankleads"],
    ["staging.crankleads.com", "crankleads"],
    ["crankleads.com", "crankleads"],
    ["crankleads.localhost", "crankleads"],
    ["crankleads.localhost:5173", "crankleads"],
    ["app.empirevu.com", "empirevu"],
    ["localhost", "empirevu"],
    ["notcrankleads.com", "empirevu"],
    ["crankleads.com.evil.example", "empirevu"],
    ["", "empirevu"],
    [null, "empirevu"],
  ])("%s → %s", (host, key) => {
    expect(brandForHost(host).key).toBe(key);
  });
});

describe("brandForOrg", () => {
  it("uses platform_brand, defaults to EmpireVu, and treats a CrankLeads tier as CrankLeads", () => {
    expect(brandForOrg({ platform_brand: "crankleads" }).key).toBe("crankleads");
    expect(brandForOrg({ platform_brand: "empirevu" }).key).toBe("empirevu");
    expect(brandForOrg({ platform_brand: "empirevu", crankleads_tier: null }).key).toBe("empirevu");
    // A row read before the migration (or a partial select) still never shows a buyer "EmpireVu".
    expect(brandForOrg({ crankleads_tier: "catch" }).key).toBe("crankleads");
    expect(brandForOrg({ platform_brand: "empirevu", crankleads_tier: "close" }).key).toBe("crankleads");
    expect(brandForOrg({ platform_brand: "bogus" }).key).toBe("empirevu");
    expect(brandForOrg(null).key).toBe("empirevu");
    expect(brandForOrg(undefined).key).toBe("empirevu");
  });

  it("CrankLeads config uses CrankLeads assets only", () => {
    const c = PLATFORM_BRANDS.crankleads;
    expect(c.name).toBe("CrankLeads");
    for (const v of [c.logoSrc, c.markSrc, c.faviconHref, c.faviconPngHref, c.appleTouchIconHref, c.supportEmail]) {
      expect(v).not.toMatch(EMPIRE);
    }
    expect(withProductName("Set up {{product}} — {{product}}", c)).toBe("Set up CrankLeads — CrankLeads");
  });
});

describe("appBaseUrlFor", () => {
  it("EmpireVu keeps APP_BASE_URL (and its localhost default); CrankLeads uses its env once set", () => {
    vi.stubEnv("APP_BASE_URL", "https://hub.example/");
    vi.stubEnv("CRANKLEADS_APP_BASE_URL", "");
    expect(appBaseUrlFor("empirevu")).toBe("https://hub.example");
    expect(appBaseUrlFor(PLATFORM_BRANDS.empirevu)).toBe("https://hub.example");
    // Unset → the same live origin as EmpireVu, never a not-yet-existing CrankLeads host.
    expect(appBaseUrlFor("crankleads")).toBe("https://hub.example");
    expect(appHostFor("crankleads")).toBe("hub.example");
    expect(configuredAppBaseUrlFor("crankleads")).toBe("https://hub.example");
    vi.stubEnv("CRANKLEADS_APP_BASE_URL", "https://cl.example/");
    expect(appBaseUrlFor("crankleads")).toBe("https://cl.example");
    expect(appHostFor("crankleads")).toBe("cl.example");
    vi.stubEnv("APP_BASE_URL", undefined as unknown as string);
    delete process.env.APP_BASE_URL;
    expect(appBaseUrlFor("empirevu")).toBe("http://localhost:3000");
    expect(configuredAppBaseUrlFor("empirevu")).toBeNull();
    expect(configuredAppBaseUrlFor("crankleads")).toBe("https://cl.example");
  });

  it("with CRANKLEADS_APP_BASE_URL unset, every CrankLeads link uses APP_BASE_URL (safe before the domain exists)", () => {
    vi.stubEnv("APP_BASE_URL", "https://app.empirevu.test");
    vi.stubEnv("CRANKLEADS_APP_BASE_URL", "");
    const cl = PLATFORM_BRANDS.crankleads;
    expect(invitationUrl("tok", cl)).toBe("https://app.empirevu.test/invite/tok");
    expect(appLinkForMissedCall({ contact_id: "c1" }, cl)).toBe("https://app.empirevu.test/crm/c1");
    const email = renderWelcomeEmail({
      ownerName: "Jane",
      businessName: "Jane's Roofing",
      tier: "catch",
      setPasswordUrl: `${appBaseUrlFor(cl)}/update-password?token_hash=x`,
      appUrl: appBaseUrlFor(cl),
      formUrl: null,
      packName: null,
      servicesNeedingPrices: 0,
    });
    // The host printed is the link's real host — no dead app.crankleads.com.
    expect(email.body).toContain("log in to CrankLeads at app.empirevu.test");
    expect(email.body).not.toContain("crankleads.com");
    // Until the domain is live the link host is the EmpireVu one; the product name never is.
    expect(`${email.subject}${email.body}`.split("app.empirevu.test").join("")).not.toMatch(EMPIRE);
  });
});

describe("owner-facing copy follows the org's brand", () => {
  const cl = PLATFORM_BRANDS.crankleads;

  it("team invite", () => {
    vi.stubEnv("APP_BASE_URL", "https://app.empirevu.test");
    vi.stubEnv("CRANKLEADS_APP_BASE_URL", "https://app.crankleads.test");
    const url = invitationUrl("tok", cl);
    expect(url).toBe("https://app.crankleads.test/invite/tok");
    const mail = renderInvitationEmail({ brand: cl, role: "member", inviteUrl: url });
    expect(mail.subject).toBe("You've been invited to join a team on CrankLeads");
    expect(mail.fromName).toBe("CrankLeads");
    expect(`${mail.subject}${mail.body}`).not.toMatch(EMPIRE);
    expect(invitationUrl("tok")).toBe("https://app.empirevu.test/invite/tok");
    expect(renderInvitationEmail({ brand: PLATFORM_BRANDS.empirevu, role: "admin", inviteUrl: "x" }).subject).toContain("EmpireVu");
  });

  it("voicemail email", () => {
    vi.stubEnv("CRANKLEADS_APP_BASE_URL", "https://app.crankleads.test");
    delete process.env.APP_BASE_URL;
    expect(appLinkForMissedCall({ contact_id: "c1" })).toBeNull(); // EmpireVu: unchanged (no link when unset)
    expect(appLinkForMissedCall({ contact_id: "c1" }, cl)).toBe("https://app.crankleads.test/crm/c1");
    const alert = buildVoicemailOwnerAlert({
      companyName: "Jane's Roofing",
      callerNumber: "+17055550101",
      appUrl: null,
      durationSeconds: null,
      transcript: null,
      textBackStatus: "sent",
      textedBack: true,
      productName: "CrankLeads",
    });
    expect(alert.body).toContain("open the call in CrankLeads");
    expect(alert.body).not.toMatch(EMPIRE);
  });

  it("monthly scorecard brand: per org, env override only for EmpireVu", () => {
    vi.stubEnv("PLATFORM_BRAND_NAME", "Acme Leads");
    expect(scorecardPlatformBrandName()).toBe("Acme Leads");
    expect(scorecardPlatformBrandName(cl)).toBe("CrankLeads");
  });

  it("help assistant: system prompt, canned reply, articles and support email", () => {
    expect(helpSystemPrompt("CrankLeads")).toContain("Help assistant inside CrankLeads");
    expect(helpSystemPrompt("CrankLeads")).not.toMatch(EMPIRE);
    expect(HELP_SYSTEM_PROMPT).toContain("inside EmpireVu");
    expect(handoffAnswer(cl)).toBe("Sure — click Contact support below and the CrankLeads team will reply by email.");
    expect(HANDOFF_ANSWER).toContain("EmpireVu team");
    for (const article of HELP_ARTICLES) {
      const branded = brandHelpArticle(article, cl);
      expect(JSON.stringify(branded), article.id).not.toMatch(EMPIRE);
      expect(JSON.stringify(branded), article.id).not.toContain("{{product}}");
    }
    vi.stubEnv("CRANKLEADS_APP_BASE_URL", "https://app.crankleads.test");
    const support = buildSupportEmail({
      requestId: "r",
      organizationId: "o",
      requesterEmail: null,
      question: "help",
      transcript: [],
      account: { ...EMPTY_ACCOUNT_CONTEXT, platformBrand: "crankleads", organizationName: "Jane's Roofing" },
      reason: "user_requested",
      appBaseUrl: null,
    });
    expect(support.subject).toMatch(/^\[CrankLeads Help\]/);
  });

  it("accounting memos", () => {
    expect(paymentDoc({ id: "p", invoice_id: "i", amount_cents: 1, method: "card", reference: null, received_at: "2026-10-05T12:00:00Z" }, "UTC", "CrankLeads").memo).toBe(
      "Card via CrankLeads",
    );
    expect(depositPaymentDoc({ id: "i", credit_cents: 1, issue_date: "2026-10-05" }, null, "UTC", "CrankLeads").memo).toBe(
      "Deposit paid on the quote, via CrankLeads",
    );
    expect(
      expenseDoc({ id: "e", spent_on: "2026-10-05", vendor: null, description: null, category: "materials", amount_cents: 1, tax_cents: 0, paid_with: "business" }, "CrankLeads").memo,
    ).toBe("Paid by the business · from CrankLeads");
  });

  it("Stripe Checkout branding for CrankLeads orgs only", () => {
    expect(checkoutBrandingFor(PLATFORM_BRANDS.empirevu)).toBeUndefined();
    expect(checkoutBrandingFor(cl)).toMatchObject({ display_name: "CrankLeads", button_color: "#a6ee2b" });
  });

  it("setup follow-ups never say EmpireVu", () => {
    const input = {
      stage: "day1" as const,
      ownerName: "Jane",
      businessName: "Jane's Roofing",
      remaining: [{ title: "Add your prices", action: "add prices" }],
      nextStepUrl: "https://app.crankleads.com/onboarding?step=services",
      setPasswordUrl: "https://app.crankleads.com/update-password?token_hash=x",
      appUrl: "https://app.crankleads.com",
      stopUrl: "https://app.crankleads.com/api/public/crankleads/setup-reminders?token=t",
    };
    const email = renderReminderEmail(input);
    expect(`${email.subject}${email.body}${email.html}`).not.toMatch(EMPIRE);
    expect(email.body).toContain("you log in at app.crankleads.com");
    expect(renderReminderSms(input)).not.toMatch(EMPIRE);
    const live = renderLiveEmail({ ownerName: "Jane", businessName: "J", phonePath: "missed_call_catcher", appUrl: input.appUrl });
    expect(`${live.subject}${live.body}${live.html}`).not.toMatch(EMPIRE);
  });

  it("platformBrand() falls back to EmpireVu", () => {
    expect(platformBrand("nope").key).toBe("empirevu");
  });
});
