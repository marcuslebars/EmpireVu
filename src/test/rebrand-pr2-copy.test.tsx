/**
 * Everdoer rebrand PR 2 copy: the owner SMS prefix switch (REBRAND_PLAN.md §1.3), the D10 entity
 * line on the privacy and delete-account pages, and the "Powered by Everdoer" site credit.
 */
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EVERDOER_ENTITY_LINE } from "@/lib/platform-brand";
import DeleteAccountPage from "@/screens/DeleteAccountPage";
import PrivacyPolicyPage from "@/screens/PrivacyPolicyPage";
import { OWNER_SMS_PREFIX, signaturePrefix, smsPrefixAllOrgs } from "@/server/services/owner-channel/common";
import { septets } from "@/server/services/staff/office-manager/compose";

afterEach(() => {
  vi.unstubAllEnvs();
});

const OLD_NAMES = /empire\s*vu|crank\s*leads|syncoree/i;

describe("owner SMS prefix", () => {
  it("is 'Everdoer: ' (10 GSM septets, shorter than the old 'CrankLeads: ')", () => {
    expect(OWNER_SMS_PREFIX).toBe("Everdoer: ");
    expect(septets(OWNER_SMS_PREFIX)).toBe(10);
  });

  it.each(["crankleads", "done_for_you"])("done-for-you (%s) always gets it, switch off or on", (value) => {
    vi.stubEnv("EVERDOER_SMS_PREFIX_ALL_ORGS", "");
    expect(signaturePrefix(value)).toBe("Everdoer: ");
    vi.stubEnv("EVERDOER_SMS_PREFIX_ALL_ORGS", "1");
    expect(signaturePrefix(value)).toBe("Everdoer: ");
  });

  it.each(["empirevu", "standard", null, undefined])("a house org (%s) gets nothing unless EVERDOER_SMS_PREFIX_ALL_ORGS is on", (value) => {
    vi.stubEnv("EVERDOER_SMS_PREFIX_ALL_ORGS", "");
    expect(signaturePrefix(value)).toBe("");
    vi.stubEnv("EVERDOER_SMS_PREFIX_ALL_ORGS", "0");
    expect(signaturePrefix(value)).toBe("");
    vi.stubEnv("EVERDOER_SMS_PREFIX_ALL_ORGS", "1");
    expect(signaturePrefix(value)).toBe("Everdoer: ");
  });

  it("reads the switch like the other EVERDOER_ flags", () => {
    expect(smsPrefixAllOrgs({})).toBe(false);
    expect(smsPrefixAllOrgs({ EVERDOER_SMS_PREFIX_ALL_ORGS: "0" })).toBe(false);
    expect(smsPrefixAllOrgs({ EVERDOER_SMS_PREFIX_ALL_ORGS: "no" })).toBe(false);
    expect(smsPrefixAllOrgs({ EVERDOER_SMS_PREFIX_ALL_ORGS: "1" })).toBe(true);
    expect(smsPrefixAllOrgs({ EVERDOER_SMS_PREFIX_ALL_ORGS: " TRUE " })).toBe(true);
    expect(smsPrefixAllOrgs({ EVERDOER_SMS_PREFIX_ALL_ORGS: "yes" })).toBe(true);
  });
});

describe("D10 entity line", () => {
  it("is the approved wording", () => {
    expect(EVERDOER_ENTITY_LINE).toBe("Everdoer is a product of Thinker Holdings Inc.");
  });

  it("privacy policy: Everdoer, hello@everdoer.com, the entity line and the new date; no old names", () => {
    const { container } = render(<PrivacyPolicyPage />);
    expect(screen.getByTestId("entity-line")).toHaveTextContent(EVERDOER_ENTITY_LINE);
    expect(screen.getByText("Last updated 13 October 2026")).toBeInTheDocument();
    expect(container.textContent).toContain("hello@everdoer.com");
    expect(container.textContent).not.toMatch(OLD_NAMES);
    expect(container.innerHTML).not.toMatch(OLD_NAMES);
  });

  it("delete-account page: Everdoer, hello@everdoer.com and the entity line; no old names", () => {
    const { container } = render(<DeleteAccountPage />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Delete your Everdoer account");
    expect(screen.getByTestId("entity-line")).toHaveTextContent(EVERDOER_ENTITY_LINE);
    expect(container.innerHTML).toContain("mailto:hello@everdoer.com?subject=Delete my Everdoer account");
    expect(container.innerHTML).not.toMatch(OLD_NAMES);
  });
});
