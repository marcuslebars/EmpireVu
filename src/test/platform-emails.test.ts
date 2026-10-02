import { afterEach, describe, expect, it, vi } from "vitest";

import { getPlatformBrand } from "@/server/platform-brand";
import { renderDigestEmail, type DigestData } from "@/server/templates/digest";
import {
  defaultOwnerAlertSubject,
  platformEmailFooter,
  renderInvitationEmail,
} from "@/server/templates/platform-emails";

/**
 * Golden copy for OWNER-facing platform email: it signs off as the platform brand
 * (CrankLeads by default) and follows PLATFORM_* env overrides. See docs/branding.md.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

const INVITE = { role: "member", inviteUrl: "https://app.example.test/invite/tok_123" };

describe("invitation email", () => {
  it("golden: default CrankLeads subject, sender and footer", () => {
    expect(renderInvitationEmail(INVITE, getPlatformBrand({}))).toEqual({
      subject: "You've been invited to join a team on CrankLeads",
      fromName: "CrankLeads",
      body: [
        "You've been invited to join a team on CrankLeads as member.",
        "",
        "Accept your invitation:",
        "https://app.example.test/invite/tok_123",
        "",
        "This link expires in 7 days.",
        "",
        "— CrankLeads",
        "Questions? hello@crankleads.com",
      ].join("\n"),
    });
  });

  it("follows PLATFORM_* overrides", () => {
    vi.stubEnv("PLATFORM_BRAND_NAME", "ShopBoss");
    vi.stubEnv("PLATFORM_SUPPORT_EMAIL", "help@shopboss.test");
    vi.stubEnv("PLATFORM_EMAIL_FROM_NAME", "ShopBoss Team");
    const email = renderInvitationEmail(INVITE, getPlatformBrand());
    expect(email.subject).toBe("You've been invited to join a team on ShopBoss");
    expect(email.fromName).toBe("ShopBoss Team");
    expect(email.body).toContain("as member.");
    expect(email.body.endsWith("— ShopBoss\nQuestions? help@shopboss.test")).toBe(true);
  });

  it("never names the engine", () => {
    const email = renderInvitationEmail(INVITE, getPlatformBrand({}));
    expect(JSON.stringify(email)).not.toMatch(/empire\s?vu/i);
  });
});

describe("owner alert + footer", () => {
  it("default notify_owner subject uses the brand", () => {
    expect(defaultOwnerAlertSubject(getPlatformBrand({}))).toBe("CrankLeads alert");
    expect(defaultOwnerAlertSubject(getPlatformBrand({ PLATFORM_BRAND_NAME: "Acme" }))).toBe("Acme alert");
  });

  it("footer is name + support contact", () => {
    expect(platformEmailFooter(getPlatformBrand({}))).toBe("— CrankLeads\nQuestions? hello@crankleads.com");
  });
});

function day(over: Partial<DigestData> = {}): DigestData {
  return {
    companyName: "A1 Marine",
    localDate: "2026-09-12",
    calls: { total: 5, booked: 2, quotesSent: 3, needsCallback: 1 },
    newLeads: 4,
    messagesNeedingReply: 2,
    quotesUnviewed48h: 1,
    todaysBookings: 3,
    usage: { smsSent: 40, emailSent: 12, voiceMinutes: 88, cap: null },
    attribution: { approvedCents: 500_000, paidCents: 150_000, currency: "CAD" },
    ...over,
  };
}

describe("owner digest email", () => {
  it("golden: subject stays company-branded; footer signs off as the platform", () => {
    const email = renderDigestEmail(day(), { deepLink: "https://app.example.test/inbox" });
    expect(email.subject).toBe("A1 Marine: your morning digest");
    expect(email.text.split("\n").slice(-3)).toEqual([
      "https://app.example.test/inbox",
      "",
      "Sent by CrankLeads · hello@crankleads.com",
    ]);
    expect(email.html).toContain(">Sent by CrankLeads · hello@crankleads.com</td>");
    expect(email.html).not.toMatch(/empire\s?vu/i);
  });

  it("quiet night carries the same footer", () => {
    const quiet = day({ calls: { total: 0, booked: 0, quotesSent: 0, needsCallback: 0 }, newLeads: 0, messagesNeedingReply: 0, quotesUnviewed48h: 0, todaysBookings: 0 });
    const email = renderDigestEmail(quiet, { deepLink: "https://app.example.test/inbox" });
    expect(email.subject).toBe("A1 Marine: quiet night");
    expect(email.text.endsWith("Sent by CrankLeads · hello@crankleads.com")).toBe(true);
  });

  it("footer follows the server env, and an explicit platform wins", () => {
    vi.stubEnv("PLATFORM_BRAND_NAME", "ShopBoss");
    vi.stubEnv("PLATFORM_SUPPORT_EMAIL", "help@shopboss.test");
    expect(renderDigestEmail(day(), { deepLink: "x" }).text).toContain("Sent by ShopBoss · help@shopboss.test");
    expect(
      renderDigestEmail(day(), { deepLink: "x", platform: { name: "Other", supportEmail: "o@other.test" } }).text,
    ).toContain("Sent by Other · o@other.test");
  });

  it("escapes the footer in HTML", () => {
    const email = renderDigestEmail(day(), { deepLink: "x", platform: { name: "A&B", supportEmail: "a@b.test" } });
    expect(email.html).toContain("Sent by A&amp;B · a@b.test");
  });
});
