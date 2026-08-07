import { describe, expect, it } from "vitest";

import { payloadFromRawLead } from "@/server/services/jobber/sync-jobs";

describe("payloadFromRawLead (raw_leads.raw_payload → JobberSyncPayload)", () => {
  it("maps a winter-storage-quote lead-capture envelope (locality, contact, no line items)", () => {
    const raw = {
      formType: "winter-storage-quote",
      source: "a1marinestorage-winter-quote",
      sourceSite: "a1marinestorage",
      contact: { name: "Dana Whitfield", email: "dana@example.com", phone: "705-555-0142" },
      message: "Service interest: Outdoor Storage",
      asset: { makeModel: "2018 Bayliner VR5", lengthFt: 22, type: "bowrider" },
      meta: { site: "a1marinestorage.ca", page: "/boat-storage/midland", locality: "Midland" },
    };
    const p = payloadFromRawLead(raw);
    expect(p.formType).toBe("winter-storage-quote");
    expect(p.locality).toBe("Midland");
    expect(p.contact.email).toBe("dana@example.com");
    expect(p.asset?.makeModel).toBe("2018 Bayliner VR5");
    // Lead-capture (no calculator) → no line items → client-only sync, team quotes.
    expect(p.lineItems).toBeUndefined();
  });

  it("carries calculator line items (cents) through unchanged for a full quote", () => {
    const raw = {
      formType: "quote",
      source: "a1marinestorage-quote",
      sourceSite: "a1marinestorage",
      contact: { email: "a@b.com" },
      lineItems: [{ description: "Shrink Wrap (24 ft)", quantity: 1, unitPriceCents: 41400 }],
    };
    const p = payloadFromRawLead(raw);
    expect(p.lineItems).toHaveLength(1);
    expect(p.lineItems?.[0]?.unitPriceCents).toBe(41400);
  });

  it("is defensive on missing / garbage input (never throws)", () => {
    expect(payloadFromRawLead(null).contact.email).toBeUndefined();
    expect(payloadFromRawLead(null).lineItems).toBeUndefined();
    expect(payloadFromRawLead("nonsense").formType).toBe("");
    expect(payloadFromRawLead(undefined).sourceSite).toBe("");
  });

  it("drops empty-string contact fields to undefined (no empty Jobber fields)", () => {
    const p = payloadFromRawLead({ contact: { name: "", email: "x@y.com", phone: "" } });
    expect(p.contact.name).toBeUndefined();
    expect(p.contact.phone).toBeUndefined();
    expect(p.contact.email).toBe("x@y.com");
  });
});
