import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "./fake-supabase";

let db: FakeDb;
const mails: Array<{ to: string; subject: string; body: string; html?: string }> = [];
let mailFails: Error | null = null;
const triggers: Array<{ eventType: string; metadata: Record<string, unknown> }> = [];

vi.mock("@/server/supabase/admin", () => ({ createSupabaseAdminClient: () => db.client }));
vi.mock("@/server/outbound/email", () => ({
  sendEmail: vi.fn(async (m: { to: string; subject: string; body: string; html?: string }) => {
    if (mailFails) throw mailFails;
    mails.push(m);
    return { id: "m1" };
  }),
}));
vi.mock("@/server/services/invoices/pdf", () => ({
  renderInvoicePdf: vi.fn(async () => new Uint8Array([37, 80, 68, 70])),
  renderStatementPdf: vi.fn(async () => new Uint8Array([1])),
}));
vi.mock("@/server/services/workflow-engine/dispatch", () => ({
  emitActivityEventAndDispatch: vi.fn(async (_ctx: unknown, ev: { eventType: string; metadata: Record<string, unknown> }) => {
    triggers.push({ eventType: ev.eventType, metadata: ev.metadata });
  }),
}));

const opens = await import("@/server/services/invoices/opens");
const tpl = await import("@/lib/reminder-template");
const { renderInvoiceReminder } = await import("@/server/services/invoices/emails");
const { buildInvoiceDocument } = await import("@/server/services/invoices/document");
const { getPublicInvoice, recordEmailOpen } = await import("@/server/services/invoices/public");
const { sendInvoiceEmail, sendInvoiceCopyEmail } = await import("@/server/services/invoices/notify");
const reminders = await import("@/server/services/invoices/reminders");
const { pushMessageForEvent } = await import("@/server/services/push/activity");

const ORG = "org-1";
const CO = "co-1";
const TOKEN = "a".repeat(32);
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const CHROME_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

function baseInvoice(over: Record<string, unknown> = {}) {
  return {
    id: "inv-1",
    organization_id: ORG,
    company_id: CO,
    contact_id: "c1",
    customer_account_id: null,
    quote_id: null,
    booking_id: null,
    invoice_number: "INV-2026-0042",
    public_token: TOKEN,
    status: "sent",
    currency: "CAD",
    title: null,
    line_items: [{ label: "Shrink wrap", description: null, quantity: 1, unitPriceCents: 50000, amountCents: 50000 }],
    subtotal_cents: 50000,
    tax_rate_bps: 1300,
    tax_cents: 6500,
    total_cents: 56500,
    credit_cents: 0,
    amount_paid_cents: 0,
    pending_payment_cents: 0,
    balance_due_cents: 56500,
    issue_date: "2026-09-24",
    due_date: "2026-10-01",
    payment_terms_days: 7,
    bill_to: { name: "Pat Smith", email: "pat@example.com" },
    sent_at: "2026-09-24T14:00:00Z",
    first_viewed_at: null,
    view_count: 0,
    last_viewed_at: null,
    email_open_count: 0,
    first_email_opened_at: null,
    last_email_opened_at: null,
    reminders_paused: false,
    reminder_count: 0,
    last_reminder_at: null,
    ...over,
  };
}

/** The two SQL counters, implemented over the fake tables (same contract as the migration). */
function installRpc() {
  (db.client as unknown as { rpc: unknown }).rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    const inv = db.tables.invoices.find((r) => r.id === args.p_invoice_id);
    const dedupe = Number(args.p_dedupe_seconds ?? 1800) * 1000;
    const now = Date.now();
    if (fn === "record_invoice_view" || fn === "record_invoice_email_open") {
      const [count, first, last] =
        fn === "record_invoice_view" ? ["view_count", "first_viewed_at", "last_viewed_at"] : ["email_open_count", "first_email_opened_at", "last_email_opened_at"];
      if (!inv || inv.status === "draft" || inv.status === "void") return { data: [{ counted: false, first_view: false, first_open: false, view_count: 0, open_count: 0 }], error: null };
      const wasFirst = !inv[first];
      if (inv[last] && now - new Date(inv[last] as string).getTime() < dedupe) {
        return { data: [{ counted: false, first_view: false, first_open: false, view_count: inv[count], open_count: inv[count] }], error: null };
      }
      inv[count] = (inv[count] as number) + 1;
      inv[last] = new Date(now).toISOString();
      inv[first] = inv[first] ?? new Date(now).toISOString();
      return { data: [{ counted: true, first_view: wasFirst, first_open: wasFirst, view_count: inv[count], open_count: inv[count] }], error: null };
    }
    if (fn === "refresh_invoice_balance") {
      if (inv && inv.first_viewed_at && inv.status === "sent") inv.status = "viewed";
      return { data: [inv], error: null };
    }
    return { data: null, error: null };
  });
}

beforeEach(() => {
  mails.length = 0;
  triggers.length = 0;
  mailFails = null;
  db = createFakeDb({
    invoices: [baseInvoice()],
    companies: [{ id: CO, organization_id: ORG, name: "A1 Marine Care", invoice_settings: {}, quote_public_base_url: "https://pay.a1marine.test", timezone: "America/Toronto" }],
    contacts: [{ id: "c1", organization_id: ORG, first_name: "Pat", email: "pat@example.com", phone: null, sms_opt_out_at: null }],
    organization_memberships: [{ organization_id: ORG, profile_id: "staff-1", role: "owner", created_at: "2026-01-01" }],
    profiles: [{ id: "staff-1", email: "owner@a1marine.test" }],
    invoice_events: [],
  });
  installRpc();
});

const events = (type: string) => db.tables.invoice_events.filter((e) => e.event_type === type);

// ── Pure helpers ────────────────────────────────────────────────────────────────

describe("open helpers", () => {
  it("knows people from programs", () => {
    expect(opens.isAutomatedAgent(IPHONE)).toBe(false);
    expect(opens.isAutomatedAgent(CHROME_MAC)).toBe(false);
    expect(opens.isAutomatedAgent("Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/120.0")).toBe(true);
    expect(opens.isAutomatedAgent("Googlebot/2.1")).toBe(true);
    expect(opens.isAutomatedAgent("curl/8.4")).toBe(true);
    expect(opens.isAutomatedAgent("node")).toBe(true);
    expect(opens.isAutomatedAgent("undici")).toBe(true);
    expect(opens.isAutomatedAgent("")).toBe(true);
    // An image load with no UA can be a desktop mail app.
    expect(opens.isAutomatedAgent("", { allowEmpty: true })).toBe(false);
    // Gmail's image proxy only fetches when the person opens the email.
    expect(opens.isAutomatedAgent("Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)", { allowEmpty: true })).toBe(false);
  });

  it("labels the device coarsely", () => {
    expect(opens.deviceLabel(IPHONE)).toBe("iPhone");
    expect(opens.deviceLabel(CHROME_MAC)).toBe("Mac");
    expect(opens.deviceLabel("Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari")).toBe("Android phone");
    expect(opens.deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("Windows PC");
    expect(opens.deviceLabel("")).toBeNull();
  });

  it("parses which email an open came from", () => {
    expect(opens.parseEmailKind("invoice")).toBe("invoice");
    expect(opens.parseEmailKind("reminder-3")).toBe("reminder-3");
    expect(opens.parseEmailKind("reminder-0")).toBeNull();
    expect(opens.parseEmailKind("reminder-x")).toBeNull();
    expect(opens.parseEmailKind(null)).toBeNull();
  });

  it("builds the image on the brand's own origin and adds it before </body>", () => {
    const url = opens.emailOpenPixelUrl(`https://pay.a1marine.test/i/${TOKEN}`, "reminder-2");
    expect(url).toBe(`https://pay.a1marine.test/api/public/invoices/${TOKEN}/open?e=reminder-2`);
    expect(opens.emailOpenPixelUrl("https://x.test/q/abc", "invoice")).toBe("");
    const html = opens.withOpenPixel("<html><body><p>Hi</p></body></html>", url);
    expect(html).toMatch(/<p>Hi<\/p><img src="https:\/\/pay\.a1marine\.test\/api\/public\/invoices\/a{32}\/open\?e=reminder-2" width="1" height="1"/);
    expect(html.endsWith("</body></html>")).toBe(true);
    expect(opens.withOpenPixel("<p>x</p>", "")).toBe("<p>x</p>");
  });
});

describe("reminder wording template", () => {
  const values = tpl.sampleReminderValues("A1 Marine Care");

  it("fills placeholders and leaves unknown ones visible", () => {
    expect(tpl.fillReminderTemplate("Hi {first_name}, {amount_due} for { invoice_number } — {company_name}", values)).toBe(
      "Hi Pat, $565.00 for INV-2026-0042 — A1 Marine Care",
    );
    expect(tpl.fillReminderTemplate("Hi {firstname}", values)).toBe("Hi {firstname}");
    expect(tpl.unknownPlaceholders("Hi {firstname} {amount_due} {foo}")).toEqual(["firstname", "foo"]);
    expect(tpl.unknownPlaceholders(tpl.DEFAULT_REMINDER_MESSAGE + tpl.DEFAULT_REMINDER_SUBJECT)).toEqual([]);
  });
});

describe("reminder email", () => {
  const company = { id: CO, organization_id: ORG, name: "A1 Marine Care", invoice_settings: {}, quote_public_base_url: "https://pay.a1marine.test" };
  const doc = () => buildInvoiceDocument(baseInvoice() as never, company as never);

  it("built-in: friendly first, plainer later", () => {
    const first = renderInvoiceReminder(doc(), { firstName: "Pat", daysOverdue: 1, index: 0 });
    expect(first.subject).toBe("Reminder: invoice INV-2026-0042 is due");
    expect(first.text).toMatch(/^Hi Pat,\n\nA friendly reminder that invoice INV-2026-0042 for \$565\.00 was due on/);
    const later = renderInvoiceReminder(doc(), { firstName: "Pat", daysOverdue: 14, index: 2 });
    expect(later.subject).toBe("Past due: invoice INV-2026-0042 ($565.00)");
    expect(later.text).toMatch(/is now 14 days past due/);
  });

  it("uses the brand's own words, escaped, with the amount + pay button still added", () => {
    const mail = renderInvoiceReminder(doc(), {
      firstName: null,
      daysOverdue: 9,
      index: 1,
      wording: { subject: "Heads up {first_name}: {invoice_number} is {days_overdue} days late", message: "Hey {first_name} <3\n\nPlease pay {amount_due}.\nThanks!" },
    });
    expect(mail.subject).toBe("Heads up there: INV-2026-0042 is 9 days late");
    expect(mail.text.startsWith("Hey there <3\n\nPlease pay $565.00.\nThanks!")).toBe(true);
    expect(mail.html).toContain("<p>Hey there &lt;3</p>");
    expect(mail.html).toContain("<p>Please pay $565.00.<br />Thanks!</p>");
    expect(mail.html).toContain("View Invoice"); // no Stripe on this brand → no online pay
    expect(mail.text).toContain("Amount due: $565.00");
  });

  it("before the due date (sent by hand) says 'is due', never 'past due' — even with custom wording", () => {
    const mail = renderInvoiceReminder(doc(), { firstName: "Pat", daysOverdue: -3, index: 0, wording: { subject: "PAST DUE", message: "You are late" } });
    expect(mail.subject).toMatch(/^Reminder: invoice INV-2026-0042 is due /);
    expect(mail.text).toMatch(/is due on .*If you've already paid/);
    expect(mail.text).not.toMatch(/late|past due/i);
    expect(renderInvoiceReminder(doc(), { firstName: "Pat", daysOverdue: 0, index: 0 }).text).toMatch(/is due today/);
  });
});

describe("reminder schedule (per invoice)", () => {
  const settings = { remindersEnabled: true, reminderDays: [1, 7, 14] };
  const inv = (over: Record<string, unknown> = {}) => baseInvoice(over) as never;

  it("books the next one from the due date", () => {
    expect(reminders.reminderSchedule(inv(), settings, "2026-09-28", null)).toMatchObject({ state: "scheduled", nextDate: "2026-10-02", nextNumber: 1, total: 3, canSendNow: true });
    expect(reminders.reminderSchedule(inv({ reminder_count: 1 }), settings, "2026-10-03", "2026-10-02")).toMatchObject({ nextDate: "2026-10-08", nextNumber: 2 });
  });

  it("an already-due reminder shows as today, or tomorrow if one went out today", () => {
    expect(reminders.reminderSchedule(inv({ reminder_count: 1 }), settings, "2026-10-10", null).nextDate).toBe("2026-10-10");
    expect(reminders.reminderSchedule(inv({ reminder_count: 1 }), settings, "2026-10-10", "2026-10-10").nextDate).toBe("2026-10-11");
  });

  it("paused, company off, all sent, no email, closed", () => {
    expect(reminders.reminderSchedule(inv({ reminders_paused: true }), settings, "2026-10-03", null)).toMatchObject({ state: "paused", paused: true, canSendNow: true });
    expect(reminders.reminderSchedule(inv(), { ...settings, remindersEnabled: false }, "2026-10-03", null).state).toBe("off");
    expect(reminders.reminderSchedule(inv({ reminder_count: 3 }), settings, "2026-10-30", null).state).toBe("done");
    expect(reminders.reminderSchedule(inv({ bill_to: { name: "Pat" } }), settings, "2026-10-03", null)).toMatchObject({ state: "no_email", canSendNow: false });
    expect(reminders.reminderSchedule(inv({ status: "paid", balance_due_cents: 0 }), settings, "2026-10-03", null)).toMatchObject({ state: "closed", canSendNow: false });
    expect(reminders.reminderSchedule(inv({ status: "draft" }), settings, "2026-10-03", null).state).toBe("closed");
  });
});

// ── Page opens ──────────────────────────────────────────────────────────────────

describe("customer opens of the invoice page", () => {
  it("first open: counted, status → viewed, owner alerted with invoice.viewed; device logged", async () => {
    const doc = await getPublicInvoice(TOKEN, { userId: null, userAgent: IPHONE });
    expect(doc).not.toBeNull();
    const inv = db.tables.invoices[0];
    expect(inv).toMatchObject({ view_count: 1, status: "viewed" });
    expect(inv.first_viewed_at).toBeTruthy();
    expect(events("viewed")).toHaveLength(1);
    expect(events("viewed")[0].metadata).toMatchObject({ count: 1, device: "iPhone" });
    expect(triggers).toEqual([{ eventType: "invoice.viewed", metadata: expect.objectContaining({ invoiceId: "inv-1", invoiceNumber: "INV-2026-0042", name: "Pat Smith" }) }]);
  });

  it("a refresh within 30 minutes is the same open; a later visit is another — and only the first alerts", async () => {
    await getPublicInvoice(TOKEN, { userAgent: IPHONE });
    await getPublicInvoice(TOKEN, { userAgent: IPHONE });
    expect(db.tables.invoices[0].view_count).toBe(1);
    db.tables.invoices[0].last_viewed_at = new Date(Date.now() - 31 * 60_000).toISOString();
    await getPublicInvoice(TOKEN, { userAgent: CHROME_MAC });
    expect(db.tables.invoices[0].view_count).toBe(2);
    expect(events("viewed").map((e) => e.metadata)).toEqual([
      { count: 1, device: "iPhone" },
      { count: 2, device: "Mac" },
    ]);
    expect(triggers).toHaveLength(1);
  });

  it("the brand's own signed-in staff, bots and void invoices don't count", async () => {
    await getPublicInvoice(TOKEN, { userId: "staff-1", userAgent: CHROME_MAC });
    await getPublicInvoice(TOKEN, { userAgent: "Mozilla/5.0 HeadlessChrome/120" });
    await getPublicInvoice(TOKEN, { userAgent: null });
    expect(db.tables.invoices[0]).toMatchObject({ view_count: 0, status: "sent", first_viewed_at: null });
    // A signed-in user from ANOTHER organization is just a person: counted.
    await getPublicInvoice(TOKEN, { userId: "someone-else", userAgent: CHROME_MAC });
    expect(db.tables.invoices[0].view_count).toBe(1);

    db.tables.invoices[0].status = "void";
    db.tables.invoices[0].last_viewed_at = null;
    await getPublicInvoice(TOKEN, { userAgent: IPHONE });
    expect(db.tables.invoices[0].view_count).toBe(1);
  });

  it("a counting failure never breaks the page", async () => {
    (db.client as unknown as { rpc: unknown }).rpc = vi.fn(async () => ({ data: null, error: { message: "function missing" } }));
    expect(await getPublicInvoice(TOKEN, { userAgent: IPHONE })).not.toBeNull();
  });
});

// ── Email opens ─────────────────────────────────────────────────────────────────

describe("email opens", () => {
  it("the customer's invoice email carries the image; the owner's copy does not", async () => {
    expect(await sendInvoiceEmail("inv-1")).toMatchObject({ delivered: true });
    expect(mails[0].html).toContain(`https://pay.a1marine.test/api/public/invoices/${TOKEN}/open?e=invoice`);
    mails.length = 0;
    await sendInvoiceCopyEmail("inv-1", "books@a1marine.test", { email: { delivered: true, reason: null, to: "pat@example.com" }, sms: null });
    expect(mails[0].html).not.toContain("/open?e=");
  });

  it("an open is logged with which email, counted with dedupe, and never changes status or alerts", async () => {
    await recordEmailOpen(TOKEN, "reminder-2", IPHONE);
    await recordEmailOpen(TOKEN, "reminder-2", IPHONE);
    expect(db.tables.invoices[0]).toMatchObject({ email_open_count: 1, status: "sent", view_count: 0 });
    expect(events("email_opened")[0].metadata).toEqual({ email: "reminder-2", count: 1, device: "iPhone" });
    expect(triggers).toEqual([]);
    await recordEmailOpen(TOKEN, "invoice", "Googlebot/2.1");
    await recordEmailOpen("b".repeat(32), "invoice", IPHONE);
    expect(events("email_opened")).toHaveLength(1);
  });
});

// ── Reminder controls ───────────────────────────────────────────────────────────

function ctx() {
  return { organizationId: ORG, actorProfileId: "staff-1", supabase: db.client } as never;
}

describe("per-invoice pause", () => {
  it("toggles, logs who did it, and the daily sweep skips a paused invoice", async () => {
    await reminders.setInvoiceRemindersPaused(ctx(), "inv-1", true);
    expect(db.tables.invoices[0].reminders_paused).toBe(true);
    expect(events("reminders_paused")[0]).toMatchObject({ actor_profile_id: "staff-1" });

    const r = await reminders.sweepInvoiceReminders(new Date("2026-10-03T15:00:00Z"));
    expect(r.flaggedOverdue).toEqual(["inv-1"]); // still turns overdue
    expect(r.reminded).toEqual([]);
    expect(mails).toHaveLength(0);

    await reminders.setInvoiceRemindersPaused(ctx(), "inv-1", false);
    expect(events("reminders_resumed")).toHaveLength(1);
    const again = await reminders.sweepInvoiceReminders(new Date("2026-10-03T15:00:00Z"));
    expect(again.reminded).toEqual(["inv-1"]);
    expect(mails[0].html).toContain("/open?e=reminder-1");
  });

  it("uses the brand's custom wording in the scheduled reminder", async () => {
    db.tables.companies[0].invoice_settings = { reminderSubject: "{company_name}: {invoice_number} overdue", reminderMessage: "Hello {first_name}, {days_overdue} days now." };
    await reminders.sweepInvoiceReminders(new Date("2026-10-03T15:00:00Z"));
    expect(mails[0].subject).toBe("A1 Marine Care: INV-2026-0042 overdue");
    expect(mails[0].body.startsWith("Hello Pat, 2 days now.")).toBe(true);
  });
});

describe("send reminder now", () => {
  const NOW = new Date("2026-10-09T15:00:00Z");

  it("sends right away, doesn't use up a scheduled reminder, and counts as today's", async () => {
    const out = await reminders.sendInvoiceReminderNow(ctx(), "inv-1", NOW);
    expect(out).toEqual({ delivered: true, reason: null, to: "pat@example.com" });
    expect(mails).toHaveLength(1);
    const inv = db.tables.invoices[0];
    expect(inv.reminder_count).toBe(0);
    expect(inv.last_reminder_at).toBe(NOW.toISOString());
    expect(events("reminder_sent")[0]).toMatchObject({ actor_profile_id: "staff-1", metadata: expect.objectContaining({ manual: true, daysOverdue: 8 }) });
    // The daily job the same day doesn't send a second one.
    const sweep = await reminders.sweepInvoiceReminders(new Date("2026-10-09T20:00:00Z"));
    expect(sweep.reminded).toEqual([]);
  });

  it("works while paused (a person asked), but not twice in a row", async () => {
    db.tables.invoices[0].reminders_paused = true;
    await reminders.sendInvoiceReminderNow(ctx(), "inv-1", NOW);
    await expect(reminders.sendInvoiceReminderNow(ctx(), "inv-1", new Date(NOW.getTime() + 30_000))).rejects.toThrow(/moment ago/);
    expect(mails).toHaveLength(1);
    expect(await reminders.sendInvoiceReminderNow(ctx(), "inv-1", new Date(NOW.getTime() + 5 * 60_000))).toMatchObject({ delivered: true });
  });

  it("refuses a paid / draft invoice or one with no email", async () => {
    db.tables.invoices[0].status = "paid";
    db.tables.invoices[0].balance_due_cents = 0;
    await expect(reminders.sendInvoiceReminderNow(ctx(), "inv-1", NOW)).rejects.toThrow(/unpaid, sent invoice/);
    db.tables.invoices[0].status = "sent";
    db.tables.invoices[0].balance_due_cents = 56500;
    db.tables.invoices[0].bill_to = { name: "Pat" };
    await expect(reminders.sendInvoiceReminderNow(ctx(), "inv-1", NOW)).rejects.toThrow(/no email address/);
    await expect(reminders.sendInvoiceReminderNow(ctx(), "nope", NOW)).rejects.toThrow();
  });

  it("a failed send gives the day back so the schedule isn't held up", async () => {
    db.tables.invoices[0].last_reminder_at = "2026-10-02T15:00:00.000Z";
    mailFails = new Error("resend down");
    const out = await reminders.sendInvoiceReminderNow(ctx(), "inv-1", NOW);
    expect(out).toMatchObject({ delivered: false, reason: "resend down" });
    expect(db.tables.invoices[0].last_reminder_at).toBe("2026-10-02T15:00:00.000Z");
    expect(events("reminder_failed")).toHaveLength(1);
  });

  it("before the due date it says 'is due'", async () => {
    db.tables.invoices[0].due_date = "2026-10-20";
    await reminders.sendInvoiceReminderNow(ctx(), "inv-1", NOW);
    expect(mails[0].subject).toBe("Reminder: invoice INV-2026-0042 is due October 20, 2026");
  });
});

describe("owner alert", () => {
  it("invoice.viewed becomes a push that opens the customer", () => {
    const msg = pushMessageForEvent(
      {
        id: "e1",
        organization_id: ORG,
        company_id: CO,
        entity_type: "contact",
        entity_id: "c1",
        event_type: "invoice.viewed",
        metadata_json: { invoiceId: "inv-1", invoiceNumber: "INV-2026-0042" },
      } as never,
      "Pat Smith",
    );
    expect(msg).toMatchObject({
      title: "Pat Smith opened their invoice",
      body: "Invoice INV-2026-0042 — first look just now.",
      category: "payments",
      data: { screen: "contact", recordId: "c1" },
    });
  });
});
