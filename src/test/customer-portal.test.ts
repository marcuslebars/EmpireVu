import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, fakeTenantContext, type FakeDb } from "./fake-supabase";

const h = vi.hoisted(() => ({ db: null as FakeDb | null, push: vi.fn((..._a: unknown[]) => Promise.resolve()) }));
vi.mock("@/server/supabase/admin", () => ({ createSupabaseAdminClient: () => h.db?.client }));
vi.mock("@/server/services/push/notify", () => ({ notifyPortalRequest: (...a: unknown[]) => h.push(...a) }));

import { getPortal, requestWork } from "@/server/services/portal/public";
import { getPortalLink, newPortalToken, resetPortalLink } from "@/server/services/portal/links";
import { portalMessage } from "@/server/services/portal/notify";
import { invoiceState, quoteState, visitStatus } from "@/server/services/portal/view";

const ORG = "org-1";
const TOKEN = "a".repeat(40);
const NOW = new Date("2026-10-04T16:00:00Z"); // noon Oct 4, Toronto

function seed(): FakeDb {
  const company = {
    id: "co-1",
    organization_id: ORG,
    name: "Sparkle Pools",
    timezone: "America/Toronto",
    brand_from_name: null,
    brand_logo_url: null,
    brand_primary_color: "#0b5cab",
    brand_accent_color: null,
    brand_reply_email: "hi@sparkle.test",
    brand_reply_phone: "705-555-0100",
    brand_website_url: null,
    tax_registration_number: null,
    business_address: null,
    invoice_settings: {},
    quote_public_base_url: "https://pay.sparkle.test",
    stripe_connected_account_id: "acct_secret",
    stripe_charges_enabled: true,
  };
  const b = (id: string, over: Record<string, unknown>) => ({ id, organization_id: ORG, company_id: "co-1", contact_id: "ct-1", title: "Pool clean", location: "14 Lake Rd", en_route_at: null, started_at: null, ...over });
  const inv = (id: string, over: Record<string, unknown>) => ({
    id,
    organization_id: ORG,
    company_id: "co-1",
    contact_id: "ct-1",
    invoice_number: id.toUpperCase(),
    title: "Pool clean",
    issue_date: "2026-09-01",
    due_date: "2026-09-15",
    total_cents: 10735,
    balance_due_cents: 10735,
    pending_payment_cents: 0,
    public_token: `${id}${"0".repeat(30)}`,
    currency: "CAD",
    created_at: "2026-09-01T00:00:00Z",
    internal_notes: "never show",
    ...over,
  });
  return createFakeDb({
    companies: [company],
    contacts: [
      { id: "ct-1", organization_id: ORG, company_id: "co-1", first_name: "Pat", last_name: "Smith", phone: "+17055550123", email: "pat@x.test" },
      { id: "ct-2", organization_id: ORG, company_id: "co-1", first_name: "Other", last_name: null },
    ],
    customer_portal_links: [{ id: "l1", organization_id: ORG, company_id: "co-1", contact_id: "ct-1", token: TOKEN, revoked_at: null, view_count: 0 }],
    bookings: [
      b("b1", { scheduled_for: "2026-10-06T13:00:00Z", status: "confirmed" }),
      b("b2", { scheduled_for: "2026-09-29T13:00:00Z", status: "completed" }),
      b("b3", { scheduled_for: "2026-10-08T13:00:00Z", status: "cancelled" }),
      b("b4", { scheduled_for: "2026-10-07T13:00:00Z", status: "confirmed", contact_id: "ct-2" }),
    ],
    quotes: [
      { id: "q1", organization_id: ORG, company_id: "co-1", contact_id: "ct-1", quote_number: "Q-1", title: "Opening", status: "sent", superseded_by: null, total_cents: 50000, approved_total_cents: null, valid_until: "2026-10-30T00:00:00Z", public_token: "qtok", created_at: "2026-09-20T00:00:00Z" },
      { id: "q2", organization_id: ORG, company_id: "co-1", contact_id: "ct-1", quote_number: "Q-0", title: "Old", status: "sent", superseded_by: "q1", total_cents: 1, approved_total_cents: null, valid_until: null, public_token: "old", created_at: "2026-09-10T00:00:00Z" },
      { id: "q3", organization_id: ORG, company_id: "co-1", contact_id: "ct-1", quote_number: null, title: "Draft", status: "draft", superseded_by: null, total_cents: 1, approved_total_cents: null, valid_until: null, public_token: "draft", created_at: "2026-09-11T00:00:00Z" },
    ],
    invoices: [
      inv("i1", {}),
      inv("i2", { status: "paid", balance_due_cents: 0 }),
      inv("i3", { status: "draft" }),
      inv("i4", { status: "void" }),
      inv("i5", { status: "sent", due_date: "2026-10-20" }),
    ].map((r) => ({ status: "sent", ...r })),
    tasks: [],
    activity_events: [],
  });
}

beforeEach(() => {
  h.db = seed();
  h.push.mockClear();
});

describe("portal view rules", () => {
  it("hides drafts, void, cancelled and superseded things", () => {
    expect(quoteState({ status: "draft" })).toBeNull();
    expect(quoteState({ status: "cancelled" })).toBeNull();
    expect(quoteState({ status: "sent", superseded_by: "q9" })).toBeNull();
    expect(quoteState({ status: "deposit_paid" })).toBe("approved");
    expect(invoiceState({ status: "draft", balance_due_cents: 1, pending_payment_cents: 0, due_date: null }, "2026-10-04")).toBeNull();
    expect(invoiceState({ status: "sent", balance_due_cents: 100, pending_payment_cents: 100, due_date: "2026-01-01" }, "2026-10-04")).toBe("processing");
    expect(visitStatus({ status: "confirmed", en_route_at: "x" })).toBe("on_the_way");
  });

  it("the portal text never names the platform", () => {
    const m = portalMessage({ firstName: "Pat", brandName: "Sparkle Pools", url: "https://pay.sparkle.test/p/x" });
    for (const part of [m.sms, m.subject, m.email]) expect(part.toLowerCase()).not.toContain("empirevu");
    expect(m.sms).toContain("https://pay.sparkle.test/p/x");
  });
});

describe("public portal", () => {
  it("shows only this customer's own items, on the brand's domain", async () => {
    const p = await getPortal(TOKEN, NOW);
    expect(p).not.toBeNull();
    expect(p!.customerName).toBe("Pat");
    expect(p!.upcoming.map((v) => v.title)).toEqual(["Pool clean"]);
    expect(p!.upcoming[0].when).toMatch(/Tuesday, October 6 at 9:00/);
    expect(p!.past).toHaveLength(1);
    expect(p!.quotes.map((q) => q.number)).toEqual(["Q-1"]);
    expect(p!.quotes[0].url).toBe("https://pay.sparkle.test/q/qtok");
    expect(p!.invoices.map((i) => i.number)).toEqual(["I1", "I2", "I5"]);
    expect(p!.invoices.map((i) => i.status)).toEqual(["overdue", "paid", "due"]);
    expect(p!.balanceCents).toBe(21470);
    expect(p!.overdueCents).toBe(10735);
    const json = JSON.stringify(p);
    for (const secret of ["acct_secret", "never show", '"co-1"', '"ct-1"', ORG, "Other"]) expect(json).not.toContain(secret);
  });

  it("refuses unknown, malformed and revoked links", async () => {
    expect(await getPortal("b".repeat(40), NOW)).toBeNull();
    expect(await getPortal("not-a-token", NOW)).toBeNull();
    h.db!.tables.customer_portal_links[0].revoked_at = "2026-10-01T00:00:00Z";
    expect(await getPortal(TOKEN, NOW)).toBeNull();
  });

  it("a work request becomes a high-priority task for the brand", async () => {
    expect(await requestWork(TOKEN, { message: "Can you open the pool in May?", preferredDate: "2027-05-01" })).toBe(true);
    const [task] = h.db!.tables.tasks;
    expect(task).toMatchObject({ organization_id: ORG, company_id: "co-1", contact_id: "ct-1", priority: "high", title: "Work request from Pat Smith" });
    expect(String(task.description)).toContain("Preferred date: 2027-05-01");
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(await requestWork("b".repeat(40), { message: "hello there" })).toBe(false);
  });
});

describe("staff link controls", () => {
  it("tokens are 40 hex chars and unique", () => {
    const a = newPortalToken();
    expect(a).toMatch(/^[a-f0-9]{40}$/);
    expect(newPortalToken()).not.toBe(a);
  });

  it("reuses the live link, and reset revokes it and issues a new one", async () => {
    const ctx = fakeTenantContext(h.db!, ORG, "owner");
    const first = await getPortalLink(ctx, "ct-1");
    expect(first.url).toBe(`https://pay.sparkle.test/p/${TOKEN}`);
    const again = await getPortalLink(ctx, "ct-2");
    expect(again.url).toMatch(/^https:\/\/pay\.sparkle\.test\/p\/[a-f0-9]{40}$/);
    const reset = await resetPortalLink(ctx, "ct-1");
    expect(reset.url).not.toBe(first.url);
    expect(h.db!.tables.customer_portal_links.find((l) => l.token === TOKEN)?.revoked_at).toBeTruthy();
    expect(await getPortal(TOKEN, NOW)).toBeNull();
  });
});
