import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "./helpers/fake-supabase";
import { captureLegacyUsage } from "@/test/helpers/legacy-usage-capture";
import { classifyByRules, type ClassifyContext } from "@/server/services/staff/email-clerk/classify";
import { ensureInbox, findInboxFor } from "@/server/services/staff/email-clerk/inboxes";
import { forwardedVia } from "@/server/services/staff/email-clerk/process";
import { inboundConfigured, inboundDomain, inboundDomains } from "@/server/services/staff/email-clerk/settings";

// Everdoer rebrand PR 1: INBOUND_EMAIL_DOMAINS (multi-domain) with INBOUND_EMAIL_DOMAIN as fallback.

let db: FakeDb;
let capture: ReturnType<typeof captureLegacyUsage>;

beforeEach(() => {
  db = createFakeDb();
  capture = captureLegacyUsage();
  vi.stubEnv("INBOUND_EMAIL_DOMAINS", "");
  vi.stubEnv("INBOUND_EMAIL_DOMAIN", "");
});
afterEach(() => {
  capture.restore();
  vi.unstubAllEnvs();
});

const ORG = "org-1";
const CO = "co-1";

function seedInbox(id: string, address: string, company = CO) {
  db.tables.email_inboxes = db.tables.email_inboxes ?? [];
  db.tables.email_inboxes.push({ id, organization_id: ORG, company_id: company, address });
}

describe("inboundDomains()", () => {
  it("unset → none (feature inert, as today)", () => {
    expect(inboundDomains()).toEqual([]);
    expect(inboundDomain()).toBeNull();
    vi.stubEnv("RESEND_WEBHOOK_SECRET", "whsec");
    expect(inboundConfigured()).toBe(false);
  });

  it("the old single INBOUND_EMAIL_DOMAIN still works and is counted as an env fallback", async () => {
    vi.stubEnv("INBOUND_EMAIL_DOMAIN", "@In.CrankLeads.com");
    expect(inboundDomains()).toEqual(["in.crankleads.com"]);
    expect(inboundDomain()).toBe("in.crankleads.com");
    const rows = await capture.rows();
    expect(rows).toEqual([expect.objectContaining({ kind: "env", key: "INBOUND_EMAIL_DOMAIN" })]);
  });

  it("INBOUND_EMAIL_DOMAINS wins; first entry is primary; invalid entries and duplicates dropped", async () => {
    vi.stubEnv("INBOUND_EMAIL_DOMAIN", "in.old.example");
    vi.stubEnv("INBOUND_EMAIL_DOMAINS", " in.everdoer.com , not a domain, in.crankleads.com,IN.EVERDOER.COM ");
    expect(inboundDomains()).toEqual(["in.everdoer.com", "in.crankleads.com"]);
    expect(inboundDomain()).toBe("in.everdoer.com");
    vi.stubEnv("RESEND_WEBHOOK_SECRET", "whsec");
    expect(inboundConfigured()).toBe(true);
    expect((await capture.rows()).filter((r) => r.kind === "env")).toEqual([]);
  });
});

describe("new addresses use the primary domain", () => {
  it("ensureInbox makes the address on the first listed domain", async () => {
    vi.stubEnv("INBOUND_EMAIL_DOMAINS", "in.everdoer.com,in.crankleads.com");
    const row = await ensureInbox(db.client, { organizationId: ORG, companyId: CO, slug: "northshore", name: "Northshore" });
    expect(row?.address).toMatch(/^northshore-[a-z0-9]{8}@in\.everdoer\.com$/);
  });
});

describe("findInboxFor matches any listed domain", () => {
  beforeEach(() => {
    vi.stubEnv("INBOUND_EMAIL_DOMAINS", "in.everdoer.com,in.crankleads.com");
    seedInbox("ib-old", "northshore-abcdefgh@in.crankleads.com");
    seedInbox("ib-new", "bayview-hjkmnpqr@in.everdoer.com", "co-2");
  });

  it("an address on the old domain still finds its inbox, and the old domain is counted", async () => {
    const hit = await findInboxFor(db.client, ["Northshore <northshore-abcdefgh@in.crankleads.com>"]);
    expect(hit?.id).toBe("ib-old");
    const rows = (await capture.rows()).filter((r) => r.kind === "inbound_email_domain");
    expect(rows).toEqual([{ kind: "inbound_email_domain", key: "in.crankleads.com", sample: null, count: 1 }]);
  });

  it("an address on the new domain finds its inbox and is not counted", async () => {
    const hit = await findInboxFor(db.client, ["bayview-hjkmnpqr@in.everdoer.com"]);
    expect(hit?.id).toBe("ib-new");
    expect((await capture.rows()).filter((r) => r.kind === "inbound_email_domain")).toEqual([]);
  });

  it("a domain no longer listed is not matched", async () => {
    vi.stubEnv("INBOUND_EMAIL_DOMAINS", "in.everdoer.com");
    expect(await findInboxFor(db.client, ["northshore-abcdefgh@in.crankleads.com"])).toBeNull();
  });

  it("a miss (unknown address on our domain) counts nothing", async () => {
    expect(await findInboxFor(db.client, ["nobody-xxxxxxxx@in.crankleads.com"])).toBeNull();
    expect((await capture.rows()).filter((r) => r.kind === "inbound_email_domain")).toEqual([]);
  });

  it("with only the old single var set, behaviour is exactly today's", async () => {
    vi.stubEnv("INBOUND_EMAIL_DOMAINS", "");
    vi.stubEnv("INBOUND_EMAIL_DOMAIN", "in.crankleads.com");
    expect((await findInboxFor(db.client, ["northshore-abcdefgh@in.crankleads.com"]))?.id).toBe("ib-old");
    expect(await findInboxFor(db.client, ["bayview-hjkmnpqr@in.everdoer.com"])).toBeNull();
  });
});

describe("our own mail on any listed domain is recognised", () => {
  const inbox = { address: "northshore-abcdefgh@in.everdoer.com", forwarded_from: null };

  it("forwardedVia accepts a list", () => {
    const domains = ["in.everdoer.com", "in.crankleads.com"];
    expect(forwardedVia({ to_addresses: ["x-yyyyyyyy@in.crankleads.com"], cc_addresses: [], headers: {} }, inbox, domains)).toBeNull();
    const headers = { "x-forwarded-for": "dana@gmail.com x-yyyyyyyy@in.crankleads.com" };
    expect(forwardedVia({ to_addresses: ["bob@other.test"], cc_addresses: [], headers }, inbox, domains)).toEqual({
      from: "dana@gmail.com",
    });
    // The single-domain form still works.
    expect(forwardedVia({ to_addresses: ["x-yyyyyyyy@in.everdoer.com"], cc_addresses: [], headers: {} }, inbox, "in.everdoer.com")).toBeNull();
  });

  it("classify treats mail from any listed domain as our own loop", () => {
    const ctx = {
      inboxAddress: inbox.address,
      inboundDomain: "in.everdoer.com",
      inboundDomains: ["in.everdoer.com", "in.crankleads.com"],
      outboundFrom: null,
      ownerEmail: null,
      suppliers: [],
      purchaseOrders: [],
      knownContact: false,
      forwardedFrom: null,
    } as unknown as ClassifyContext;
    const facts = { fromName: null, subject: "Re: hello", text: "hi", headers: {}, auth: null };
    expect(classifyByRules({ ...facts, fromAddress: "other-zzzzzzzz@in.crankleads.com" }, ctx).rule?.category).toBe("no_reply");
    expect(classifyByRules({ ...facts, fromAddress: "other-zzzzzzzz@in.everdoer.com" }, ctx).rule?.category).toBe("no_reply");
    // Without the list (old callers), only the primary domain counts as ours.
    const single = { ...ctx, inboundDomains: undefined } as ClassifyContext;
    expect(classifyByRules({ ...facts, fromAddress: "other-zzzzzzzz@in.crankleads.com" }, single).rule?.category).not.toBe("no_reply");
  });
});
