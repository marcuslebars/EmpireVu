/**
 * Everdoer rebrand PR 2 copy: the ONE SMS branding switch (EVERDOER_SMS_BRANDING; REBRAND_PLAN.md
 * §1.3, A2P), the D10 entity line on the privacy and delete-account pages, and the AI caller-echo
 * platform-name filter.
 */
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EVERDOER_ENTITY_LINE } from "@/lib/platform-brand";
import DeleteAccountPage from "@/screens/DeleteAccountPage";
import PrivacyPolicyPage from "@/screens/PrivacyPolicyPage";
import { renderLiveSms, renderReminderSms } from "@/server/services/done-for-you/followup-messages";
import { renderForwardingSms } from "@/server/services/dfy/messages";
import { LEGACY_OWNER_SMS_PREFIX, OWNER_SMS_PREFIX, signaturePrefix } from "@/server/services/owner-channel/common";
import { smsBrandingOn, smsPlatformName } from "@/server/services/rebrand/sms-branding";
import { septets } from "@/server/services/staff/office-manager/compose";
import { platformUnknownSenderText } from "@/server/services/twilio/inbound-sms";
import { safeEcho } from "@/server/services/voice/post-call";

afterEach(() => {
  vi.unstubAllEnvs();
});

const OLD_NAMES = /empire\s*vu|crank\s*leads|syncoree/i;

const OLD_UNKNOWN_SENDER =
  "CrankLeads: this number is for CrankLeads account owners. To reach a business, please text or call them directly. Reply STOP to opt out.";

const REMINDER: Parameters<typeof renderReminderSms>[0] = {
  stage: "day1",
  ownerName: "Jane Doe",
  businessName: "Jane's Roofing",
  action: "quick_setup",
  actionUrl: "https://x.test/setup/t",
  phonePath: "missed_call_catcher",
  remaining: [],
  appUrl: "https://x.test",
  stopUrl: "https://x.test/stop",
};

describe("EVERDOER_SMS_BRANDING off (default): every SMS text is byte-identical to before the rebrand", () => {
  it("owner prefix: 'CrankLeads: ' for done-for-you, nothing for house orgs", () => {
    expect(smsBrandingOn()).toBe(false);
    for (const v of ["crankleads", "done_for_you"]) expect(signaturePrefix(v)).toBe("CrankLeads: ");
    for (const v of ["empirevu", "standard", null, undefined]) expect(signaturePrefix(v)).toBe("");
    expect(LEGACY_OWNER_SMS_PREFIX).toBe("CrankLeads: ");
  });

  it("platform-number unknown-sender / HELP reply is today's done-for-you text", () => {
    expect(platformUnknownSenderText()).toBe(OLD_UNKNOWN_SENDER);
  });

  it("done-for-you texts and the weekly text keep the old names", () => {
    expect(smsPlatformName("done_for_you")).toBe("CrankLeads");
    expect(smsPlatformName("standard")).toBe("EmpireVu");
    vi.stubEnv("PLATFORM_BRAND_NAME", "Acme");
    expect(smsPlatformName("standard")).toBe("Acme");
    vi.stubEnv("EVERDOER_BRAND_NAME", "Acme Pro");
    expect(smsPlatformName("standard")).toBe("Acme Pro"); // the new name wins over the old one
    vi.stubEnv("EVERDOER_BRAND_NAME", "");
    expect(renderForwardingSms({ ownerName: "Jane Doe", businessName: "Jane's Roofing", forwardUrl: "https://x.test/f/t", phonePath: "missed_call_catcher", method: "dial_code" })).toMatch(/^CrankLeads: Hi Jane, /);
    expect(renderLiveSms({ ownerName: "Jane Doe", businessName: "Jane's Roofing", phonePath: "missed_call_catcher", number: null, siteUrl: null, appUrl: "https://x.test", setPasswordUrl: null })).toMatch(/^CrankLeads: /);
    expect(renderReminderSms({ ...REMINDER })).toMatch(/^CrankLeads: Hi Jane, /);
  });
});

describe("EVERDOER_SMS_BRANDING on: Everdoer everywhere, for every org", () => {
  it("reads 1 / true / yes", () => {
    for (const v of ["1", " TRUE ", "yes"]) expect(smsBrandingOn({ EVERDOER_SMS_BRANDING: v })).toBe(true);
    for (const v of ["", "0", "no", "off"]) expect(smsBrandingOn({ EVERDOER_SMS_BRANDING: v })).toBe(false);
  });

  it("'Everdoer: ' (10 septets, shorter than 'CrankLeads: ') for every org", () => {
    vi.stubEnv("EVERDOER_SMS_BRANDING", "1");
    expect(OWNER_SMS_PREFIX).toBe("Everdoer: ");
    expect(septets(OWNER_SMS_PREFIX)).toBeLessThan(septets(LEGACY_OWNER_SMS_PREFIX));
    for (const v of ["crankleads", "done_for_you", "empirevu", "standard", null]) expect(signaturePrefix(v)).toBe("Everdoer: ");
  });

  it("unknown-sender reply and done-for-you texts say Everdoer", () => {
    vi.stubEnv("EVERDOER_SMS_BRANDING", "1");
    expect(platformUnknownSenderText()).toBe(
      "Everdoer: this number is for Everdoer account owners. To reach a business, please text or call them directly. Reply STOP to opt out.",
    );
    expect(smsPlatformName("done_for_you")).toBe("Everdoer");
    expect(smsPlatformName("standard")).toBe("Everdoer");
    expect(renderForwardingSms({ ownerName: "Jane Doe", businessName: "Jane's Roofing", forwardUrl: "https://x.test/f/t", phonePath: "missed_call_catcher", method: "dial_code" })).toMatch(/^Everdoer: Hi Jane, /);
  });
});

describe("caller-echo platform-name filter (voice/post-call safeEcho)", () => {
  it.each(["Everdoer", "ever doer", "call Everdoer back", "EVERDOER"])("blocks %s", (text) => {
    expect(safeEcho(text, 80)).toBeNull();
  });
  it.each(["Clever Doerr", "forever doer", "Whoever does roofs"])("keeps %s", (text) => {
    expect(safeEcho(text, 80)).toBe(text);
  });
});

describe("D10 entity line", () => {
  it("is the approved wording", () => {
    expect(EVERDOER_ENTITY_LINE).toBe("Everdoer is operated by Everdoer Technologies Inc.");
  });

  it("privacy policy: Everdoer, hello@everdoer.com, the entity line and the new date; no old name", () => {
    const { container } = render(<PrivacyPolicyPage />);
    expect(screen.getByTestId("entity-line")).toHaveTextContent(EVERDOER_ENTITY_LINE);
    expect(screen.getByText("Last updated 15 October 2026")).toBeInTheDocument();
    expect(container.textContent).toContain("hello@everdoer.com");
    expect(container.textContent).toContain("in the Everdoer mobile app.");
    expect(container.innerHTML).not.toMatch(OLD_NAMES);
  });

  it("delete-account page: Everdoer, hello@everdoer.com and the entity line; no old name", () => {
    const { container } = render(<DeleteAccountPage />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Delete your Everdoer account");
    expect(screen.getByTestId("entity-line")).toHaveTextContent(EVERDOER_ENTITY_LINE);
    expect(container.innerHTML).toContain("mailto:hello@everdoer.com?subject=Delete my Everdoer account");
    expect(container.innerHTML).toContain("Open the Everdoer app and sign in.");
    expect(container.innerHTML).not.toMatch(OLD_NAMES);
  });
});
