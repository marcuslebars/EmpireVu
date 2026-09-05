import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderTemplate, type MessageTemplateData } from "@/server/services/workflow-engine/interpolate";

const data: MessageTemplateData = {
  contact: { first_name: "Jane", last_name: "Smith", phone: "+17055550188" },
  company: { name: "A1 Marine Care", booking_url: "https://app.empirevu.com/book/co-1" },
  booking: { scheduled_for: "2026-09-15T18:00:00Z", duration_minutes: 60 },
  quote: null,
  fields: { status: "qualified", value_cents: 12345 },
};

beforeEach(() => {
  vi.stubEnv("BUSINESS_TIMEZONE", "America/Toronto");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("renderTemplate", () => {
  it("resolves entity paths and bare fields", () => {
    expect(renderTemplate("Hi {{ contact.first_name }}, from {{ company.name }}", data)).toBe(
      "Hi Jane, from A1 Marine Care",
    );
    expect(renderTemplate("Book: {{ company.booking_url }}", data)).toBe(
      "Book: https://app.empirevu.com/book/co-1",
    );
    expect(renderTemplate("Stage: {{ status }}", data)).toBe("Stage: qualified");
  });

  it("applies the date and time filters in the business timezone", () => {
    // 2026-09-15 18:00 UTC is 14:00 in Toronto (EDT).
    expect(renderTemplate("{{ booking.scheduled_for | date }}", data)).toBe("Sep 15, 2026");
    expect(renderTemplate("{{ booking.scheduled_for | time }}", data)).toBe("2:00 PM");
  });

  it("applies the money filter (cents → currency)", () => {
    expect(renderTemplate("Total {{ value_cents | money }}", data)).toBe("Total $123.45");
  });

  it("renders unknown paths and null entities as empty (never a literal token)", () => {
    expect(renderTemplate("Quote: {{ quote.public_url }}!", data)).toBe("Quote: !");
    expect(renderTemplate("{{ contact.middle_name }}{{ nope }}", data)).toBe("");
  });

  it("tolerates whitespace and multiple tokens", () => {
    expect(renderTemplate("{{contact.first_name}} / {{ company.name }}", data)).toBe("Jane / A1 Marine Care");
  });
});
