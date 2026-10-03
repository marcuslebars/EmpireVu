/**
 * Cross-PR glue: no "Hi Lead," texts, the scorecard + hosted form read the central
 * platform brand, and customer-facing pages are titled with the client's business.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

import {
  UNKNOWN_FIRST_NAME_GREETING,
  UNKNOWN_FIRST_NAME_PLACEHOLDER,
  withGreetingName,
} from "@/server/services/workflow-engine/context";
import { renderTemplate } from "@/server/services/workflow-engine/interpolate";

import { scorecardPlatformBrandName } from "@/server/services/monthly-scorecard/platform-brand";
import { useDocumentTitle } from "@/lib/use-document-title";

const interpolate = (t: string, d: { contact: Record<string, unknown> | null }) =>
  renderTemplate(t, { contact: d.contact, company: null, booking: null, quote: null, fields: {} });

describe("greeting name in message templates", () => {
  const body = "Hi {{contact.first_name}}, sorry we missed you!";

  it("renders the placeholder first name as 'there'", () => {
    const contact = withGreetingName({ id: "c1", first_name: UNKNOWN_FIRST_NAME_PLACEHOLDER, phone: "+17055550101" });
    expect(contact?.first_name).toBe(UNKNOWN_FIRST_NAME_GREETING);
    expect(interpolate(body, { contact })).toBe("Hi there, sorry we missed you!");
  });

  it("renders a blank or missing first name as 'there'", () => {
    expect(withGreetingName({ id: "c1", first_name: "  " })?.first_name).toBe("there");
    expect(withGreetingName({ id: "c1" })?.first_name).toBe("there");
  });

  it("keeps a real first name and does not mutate the row", () => {
    const row = { id: "c1", first_name: "Jane" };
    expect(withGreetingName(row)).toBe(row);
    expect(interpolate(body, { contact: withGreetingName(row) })).toBe("Hi Jane, sorry we missed you!");
  });

  it("passes null through", () => {
    expect(withGreetingName(null)).toBeNull();
  });
});

describe("monthly scorecard platform name", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("defaults to EmpireVu", () => {
    vi.stubEnv("PLATFORM_BRAND_NAME", "");
    expect(scorecardPlatformBrandName()).toBe("EmpireVu");
  });

  it("can be overridden with PLATFORM_BRAND_NAME", () => {
    vi.stubEnv("PLATFORM_BRAND_NAME", "Acme Pro");
    expect(scorecardPlatformBrandName()).toBe("Acme Pro");
  });
});

describe("useDocumentTitle", () => {
  it("sets the title while mounted and restores it on unmount", () => {
    document.title = "Operator tab";
    const { unmount, rerender } = renderHook(({ t }) => useDocumentTitle(t), { initialProps: { t: null as string | null } });
    expect(document.title).toBe("Operator tab");
    rerender({ t: "Book with Kirk Snow Removal" });
    expect(document.title).toBe("Book with Kirk Snow Removal");
    unmount();
    expect(document.title).toBe("Operator tab");
  });
});
