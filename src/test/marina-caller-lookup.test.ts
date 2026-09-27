import { describe, expect, it } from "vitest";

import {
  ageLabel,
  boatFromSnapshot,
  greetingFor,
  lookupCaller,
  spokenBooking,
  toDynamicVariables,
  UNKNOWN_CALLER,
  type CallerProfile,
} from "@/server/services/retell/caller-lookup";
import type { RetellAdminClient } from "@/server/services/retell/tenant";

/** A chainable stand-in for the Supabase query builder: every filter is recorded, and
 *  the terminal maybeSingle() answers from a per-table fixture. */
function fakeAdmin(tables: Record<string, unknown>, calls: Array<{ table: string; filters: unknown[] }> = []) {
  return {
    from(table: string) {
      const filters: unknown[] = [];
      calls.push({ table, filters });
      const builder: Record<string, unknown> = {};
      for (const m of ["select", "eq", "neq", "is", "not", "in", "gte", "order", "limit"]) {
        builder[m] = (...args: unknown[]) => {
          filters.push([m, ...args]);
          return builder;
        };
      }
      builder.maybeSingle = async () => {
        const v = tables[table];
        if (v instanceof Error) throw v;
        return { data: v ?? null, error: null };
      };
      return builder;
    },
  } as unknown as RetellAdminClient;
}

const NOW = new Date("2026-09-27T14:00:00Z");
const CARE = { companyName: "A1 Marine Care", agentName: "Marina" };

describe("caller lookup", () => {
  it("greets a returning caller by name and boat, with their quote and booking", async () => {
    const calls: Array<{ table: string; filters: unknown[] }> = [];
    const admin = fakeAdmin(
      {
        contacts: { id: "c1", first_name: "Dana", last_name: "Lee" },
        quotes: {
          id: "q1",
          subtotal_cents: 115325,
          deposit_paid_at: null,
          created_at: "2026-09-25T15:00:00Z",
          input_snapshot: { services: [{ serviceId: "shrink_wrap", lengthFt: 24 }], hullType: "bowrider" },
          line_items: [
            { label: "Mobile shrink wrap", selected: true },
            { label: "Winterization — outboard", selected: true },
          ],
        },
        bookings: { scheduled_for: "2026-09-29T13:00:00Z" },
        quote_events: { id: "e1" },
      },
      calls,
    );

    const p = await lookupCaller(admin, {
      organizationId: "org_1",
      companyId: "co_care",
      phone: "(705) 555-1234",
      timeZone: "America/Toronto",
      now: NOW,
    });

    expect(p).toMatchObject({
      known: true,
      firstName: "Dana",
      boat: "24 ft bowrider",
      services: "shrink wrap, Winterization",
      quoteId: "q1",
      quoteTotal: "$1,153.25",
      quoteAgeLabel: "2 days ago",
      bookedWindow: "Tuesday, September 29 in the morning",
      depositPaid: false,
      depositLinkSent: true,
    });
    // Every read is pinned to the resolved company — never another brand's contacts.
    const contactQuery = calls.find((c) => c.table === "contacts")!;
    expect(contactQuery.filters).toContainEqual(["eq", "company_id", "co_care"]);
    expect(contactQuery.filters).toContainEqual(["eq", "phone_last10", "7055551234"]);

    expect(toDynamicVariables(p, CARE)).toMatchObject({
      greeting: "Thanks for calling A1 Marine Care, this is Marina. Hi Dana — are you calling about the 24 ft bowrider?",
      caller_known: "true",
      quote_total: "$1,153.25",
      deposit_link_sent: "true",
    });
  });

  it("answers as a new caller for an unknown number", async () => {
    const p = await lookupCaller(fakeAdmin({}), {
      organizationId: "org_1",
      companyId: "co_care",
      phone: "+17055550000",
      timeZone: "America/Toronto",
    });
    expect(p).toEqual(UNKNOWN_CALLER);
  });

  it("fails open when the database errors", async () => {
    const p = await lookupCaller(fakeAdmin({ contacts: new Error("boom") }), {
      organizationId: "org_1",
      companyId: "co_care",
      phone: "+17055551234",
      timeZone: "America/Toronto",
    });
    expect(p).toEqual(UNKNOWN_CALLER);
  });

  it("does not look up a withheld number", async () => {
    expect(
      await lookupCaller(fakeAdmin({}), { organizationId: "o", companyId: "c", phone: "anonymous", timeZone: "UTC" }),
    ).toEqual(UNKNOWN_CALLER);
  });

  it("knows a known contact with no quote yet", async () => {
    const p = await lookupCaller(fakeAdmin({ contacts: { id: "c1", first_name: "Sam", last_name: null } }), {
      organizationId: "org_1",
      companyId: "co_care",
      phone: "+17055551234",
      timeZone: "America/Toronto",
    });
    expect(p).toMatchObject({ known: true, firstName: "Sam", boat: "", quoteId: "", depositLinkSent: false });
    expect(greetingFor(p, CARE)).toBe("Thanks for calling A1 Marine Care, this is Marina. Hi Sam — how can I help today?");
  });
});

describe("greeting + formatting", () => {
  const known: CallerProfile = { ...UNKNOWN_CALLER, known: true, firstName: "Dana", boat: "24 ft bowrider" };

  it("uses the owner's templates when set (A1 keeps its shrink-wrap opener)", () => {
    const g = {
      ...CARE,
      greetingNew: "Thanks for calling {{company_name}}, this is {{agent_name}}. Are you calling about shrink wrapping, or something else?",
      greetingReturning: "Hi {{caller_first_name}}, it's {{agent_name}} — still the {{caller_boat}}?",
    };
    expect(greetingFor(UNKNOWN_CALLER, g)).toBe(
      "Thanks for calling A1 Marine Care, this is Marina. Are you calling about shrink wrapping, or something else?",
    );
    expect(greetingFor(known, g)).toBe("Hi Dana, it's Marina — still the 24 ft bowrider?");
  });

  it("stays neutral when the brand couldn't be resolved in time", () => {
    expect(greetingFor(UNKNOWN_CALLER, { companyName: "", agentName: "Marina" })).toBe(
      "Hi, this is Marina. How can I help you today?",
    );
  });

  it("every variable is a string, never undefined", () => {
    for (const v of Object.values(toDynamicVariables(UNKNOWN_CALLER, CARE))) expect(typeof v).toBe("string");
  });

  it("says ages and booked halves the way a person would", () => {
    expect(ageLabel(new Date("2026-09-27T09:00:00Z"), NOW)).toBe("earlier today");
    expect(ageLabel(new Date("2026-09-26T09:00:00Z"), NOW)).toBe("yesterday");
    // 23 hours ago, but on yesterday's date in Toronto.
    expect(ageLabel(new Date("2026-09-27T02:00:00Z"), NOW)).toBe("yesterday");
    expect(ageLabel(new Date("2026-09-17T09:00:00Z"), NOW)).toBe("last week");
    expect(spokenBooking("2026-09-29T17:00:00Z", "America/Toronto")).toBe("Tuesday, September 29 in the afternoon");
  });

  it("describes the boat from the quote's pricing inputs", () => {
    expect(boatFromSnapshot({ services: [{ lengthFt: 22 }], hullType: "pontoon" })).toBe("22 ft pontoon");
    expect(boatFromSnapshot({ services: [{ lengthFt: 18 }], hullType: "other" })).toBe("18 ft boat");
    expect(boatFromSnapshot(null)).toBe("");
  });
});
