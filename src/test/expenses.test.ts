import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, fakeTenantContext, type FakeDb } from "./fake-supabase";

let db: FakeDb;
const removed: string[] = [];
let receiptThere = true;

vi.mock("@/server/services/expenses/receipts", () => ({
  receiptExists: vi.fn(async () => receiptThere),
  removeReceipt: vi.fn(async (_org: string, path: string | null) => {
    if (path) removed.push(path);
  }),
  signReceiptUrls: vi.fn(async (_org: string, paths: string[]) => new Map(paths.map((p) => [p, `https://signed/${p}`]))),
}));

const aiCalls: Array<Record<string, unknown>> = [];
let aiAnswer = "{}";
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      create: vi.fn(async (req: Record<string, unknown>) => {
        aiCalls.push(req);
        return { id: "msg_1", model: "m", content: [{ type: "text", text: aiAnswer }], usage: { input_tokens: 10, output_tokens: 5 } };
      }),
    };
  },
}));

const rules = await import("@/server/services/expenses/rules");
const { readReceipt, ReceiptReadingUnavailableError } = await import("@/server/ai/receipt-reader");
const svc = await import("@/server/services/expenses/service");
const { computeJobProfit } = await import("@/server/services/time/logic");
const { buildPeriod, computeOverview, emptyOverviewInputs } = await import("@/server/services/reports/overview-logic");
const { hasUnpricedJobLine } = await import("@/server/services/invoices/auto");

const ORG = "0b1e2c3d-0000-4000-8000-000000000001";
const OTHER_ORG = "0b1e2c3d-0000-4000-8000-000000000002";
const CO = "c0000000-0000-4000-8000-000000000001";
const CO2 = "c0000000-0000-4000-8000-000000000002";
const JOB = "b0000000-0000-4000-8000-000000000001";
const OWNER = "a0000000-0000-4000-8000-000000000001";
const CREW = "a0000000-0000-4000-8000-000000000002";
const RECEIPT = `${ORG}/d0000000-0000-4000-8000-000000000001.jpg`;

function expenseRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `e-${Math.random().toString(16).slice(2)}`,
    organization_id: ORG,
    company_id: CO,
    booking_id: null,
    spent_on: "2026-10-03",
    vendor: "Home Depot",
    description: null,
    category: "materials",
    amount_cents: 11300,
    tax_cents: 1300,
    paid_with: "business",
    reimbursed_at: null,
    reimbursed_by: null,
    billable: false,
    billed_invoice_id: null,
    receipt_path: null,
    receipt_type: null,
    created_by: CREW,
    created_at: "2026-10-03T15:00:00Z",
    updated_at: "2026-10-03T15:00:00Z",
    ...over,
  };
}

beforeEach(() => {
  removed.length = 0;
  receiptThere = true;
  db = createFakeDb({
    companies: [{ id: CO, organization_id: ORG, name: "A1 Marine Care" }],
    bookings: [{ id: JOB, organization_id: ORG, company_id: CO, title: "Shrink wrap — 28ft Sea Ray", status: "completed" }],
    profiles: [
      { id: OWNER, full_name: "Marcus Owner", email: "owner@example.com" },
      { id: CREW, full_name: "Lee Park", email: "lee@example.com" },
    ],
    expenses: [],
    invoices: [],
  });
});

// ── Rules ────────────────────────────────────────────────────────────────────

describe("receipt paths", () => {
  it("accepts only this org's uuid-named jpg/pdf", () => {
    expect(rules.receiptTypeOfPath(ORG, RECEIPT)).toBe("image/jpeg");
    expect(rules.receiptTypeOfPath(ORG, RECEIPT.replace(".jpg", ".pdf"))).toBe("application/pdf");
    expect(rules.receiptTypeOfPath(OTHER_ORG, RECEIPT)).toBeNull();
    expect(rules.receiptTypeOfPath(ORG, `${ORG}/../${OTHER_ORG}/x.jpg`)).toBeNull();
    expect(rules.receiptTypeOfPath(ORG, `${ORG}/D0000000-0000-4000-8000-000000000001.jpg`)).toBeNull();
    expect(rules.receiptTypeOfPath(ORG, `${ORG}/d0000000-0000-4000-8000-000000000001.png`)).toBeNull();
    expect(rules.receiptTypeOfPath(ORG, `${ORG}/sub/d0000000-0000-4000-8000-000000000001.jpg`)).toBeNull();
  });

  it("builds the path the bucket expects", () => {
    expect(rules.receiptPathFor(ORG, "d0000000-0000-4000-8000-000000000001", "application/pdf")).toBe(`${ORG}/d0000000-0000-4000-8000-000000000001.pdf`);
  });
});

describe("validation", () => {
  const base = { spentOn: "2026-10-03", amountCents: 5000 };
  it("rejects tax above the total and billing without a job", () => {
    expect(rules.expenseCreateSchema.safeParse({ ...base, taxCents: 6000 }).success).toBe(false);
    expect(rules.expenseCreateSchema.safeParse({ ...base, billable: true }).success).toBe(false);
    expect(rules.expenseCreateSchema.safeParse({ ...base, billable: true, bookingId: JOB }).success).toBe(true);
    expect(rules.expenseCreateSchema.safeParse({ ...base, amountCents: 0 }).success).toBe(false);
    expect(rules.expenseCreateSchema.parse(base)).toMatchObject({ category: "other", taxCents: 0, paidWith: "business", billable: false });
  });

  it("caps list ranges at two years, except for one job's expenses", () => {
    expect(rules.expenseListQuerySchema.safeParse({ from: "2024-01-01", to: "2026-10-05" }).success).toBe(false);
    expect(rules.expenseListQuerySchema.safeParse({ from: "2000-01-01", to: "2100-01-01", bookingId: JOB }).success).toBe(true);
    expect(rules.expenseListQuerySchema.safeParse({ from: "2026-10-05", to: "2026-10-01" }).success).toBe(false);
  });
});

describe("summaries", () => {
  it("counts cost before tax, and only unpaid out-of-pocket money as owed", () => {
    const s = rules.summarizeExpenses([
      { category: "materials", amount_cents: 11300, tax_cents: 1300, paid_with: "business", reimbursed_at: null, booking_id: JOB, created_by: CREW },
      { category: "fuel", amount_cents: 6000, tax_cents: 690, paid_with: "personal", reimbursed_at: null, booking_id: null, created_by: CREW },
      { category: "fuel", amount_cents: 4000, tax_cents: 0, paid_with: "personal", reimbursed_at: "2026-10-04T00:00:00Z", booking_id: null, created_by: CREW },
      { category: "materials", amount_cents: 2260, tax_cents: 260, paid_with: "personal", reimbursed_at: null, booking_id: JOB, created_by: OWNER },
    ]);
    expect(s).toMatchObject({ count: 4, totalCents: 23560, taxCents: 2250, preTaxCents: 21310, onJobsCents: 12000, overheadCents: 9310, owedCents: 8260 });
    expect(s.byCategory).toEqual([
      { category: "materials", label: "Materials & supplies", cents: 12000, count: 2 },
      { category: "fuel", label: "Fuel", cents: 9310, count: 2 },
    ]);
    expect(s.owed).toEqual([
      { profileId: CREW, cents: 6000, count: 1 },
      { profileId: OWNER, cents: 2260, count: 1 },
    ]);
  });

  it("bills an expense at cost before tax, named by what and where", () => {
    expect(rules.billableLine({ vendor: "Home Depot", description: "Shrink wrap", category: "materials", amount_cents: 11300, tax_cents: 1300 })).toEqual({
      label: "Shrink wrap (Home Depot)",
      description: null,
      quantity: 1,
      unitPriceCents: 10000,
    });
    expect(rules.billableLine({ vendor: null, description: null, category: "equipment", amount_cents: 5000, tax_cents: 0 }).label).toBe("Equipment rental");
  });

  it("writes CSV rows a spreadsheet can't execute", () => {
    const row = rules.csvRow({
      spentOn: "2026-10-03",
      vendor: "=HYPERLINK(\"x\")",
      description: "Tape, 2 rolls",
      category: "materials",
      amountCents: 11300,
      taxCents: 1300,
      jobTitle: null,
      paidWith: "personal",
      reimbursedAt: null,
      billable: false,
      personName: "Lee Park",
      hasReceipt: true,
    });
    expect(row).toBe(`2026-10-03,"'=HYPERLINK(""x"")","Tape, 2 rolls",Materials & supplies,113.00,13.00,100.00,,Out of pocket,Owed,,Lee Park,Yes`);
  });
});

describe("cleaning what the AI read", () => {
  const raw = { vendor: " Canadian Tire ", date: "2026-10-02", totalCents: 5650, taxCents: 650, category: "tools", description: "Socket set" };
  it("keeps sane values", () => {
    expect(rules.cleanReceiptScan(raw, "2026-10-05")).toEqual({
      vendor: "Canadian Tire",
      spentOn: "2026-10-02",
      amountCents: 5650,
      taxCents: 650,
      category: "tools",
      description: "Socket set",
    });
  });
  it("drops doubtful dates, money and categories", () => {
    expect(rules.cleanReceiptScan({ ...raw, date: "2024-01-01" }, "2026-10-05").spentOn).toBeNull();
    expect(rules.cleanReceiptScan({ ...raw, date: "2026-02-30" }, "2026-10-05").spentOn).toBeNull();
    expect(rules.cleanReceiptScan({ ...raw, date: "2026-12-25" }, "2026-10-05").spentOn).toBeNull();
    expect(rules.cleanReceiptScan({ ...raw, totalCents: -5 }, "2026-10-05").amountCents).toBeNull();
    expect(rules.cleanReceiptScan({ ...raw, taxCents: 9000 }, "2026-10-05").taxCents).toBeNull();
    expect(rules.cleanReceiptScan({ ...raw, category: "groceries" }, "2026-10-05").category).toBeNull();
    expect(rules.cleanReceiptScan({ vendor: null, date: null, totalCents: null, taxCents: null, category: null, description: null }, "2026-10-05")).toEqual({
      vendor: null,
      spentOn: null,
      amountCents: null,
      taxCents: null,
      category: null,
      description: null,
    });
  });
});

// ── Job profit, reports, invoices ────────────────────────────────────────────

describe("job profit", () => {
  it("subtracts the job's expenses before tax", () => {
    const p = computeJobProfit({
      revenueCents: 50000,
      revenueSource: "invoice",
      entries: [],
      rates: new Map(),
      materials: [{ quantity: 2, unit_cost_cents: 2500 }],
      expenses: [
        { amount_cents: 11300, tax_cents: 1300 },
        { amount_cents: 2000, tax_cents: 0 },
      ],
    });
    expect(p).toMatchObject({ materialsCents: 5000, expensesCents: 12000, costCents: 17000, profitCents: 33000, marginPct: 66 });
  });
});

describe("reports overview spending", () => {
  it("totals this period vs last, by category, with what's owed today", () => {
    const period = buildPeriod("2026-10-01", "2026-11-01", "America/Toronto");
    const r = computeOverview(
      {
        ...emptyOverviewInputs(),
        expenses: [
          { spentOn: "2026-10-03", cents: 10000, category: "materials", onJob: true },
          { spentOn: "2026-10-20", cents: 5000, category: "fuel", onJob: false },
          { spentOn: "2026-10-31", cents: 2000, category: "fuel", onJob: false },
          { spentOn: "2026-09-15", cents: 8000, category: "materials", onJob: true },
          { spentOn: "2026-11-01", cents: 99999, category: "other", onJob: false },
        ],
        owedCents: 6000,
      },
      period,
      new Date("2026-10-31T16:00:00Z"),
    );
    expect(r.spending).toEqual({
      spent: { value: 17000, previous: 8000 },
      count: 3,
      onJobsCents: 10000,
      overheadCents: 7000,
      byCategory: [
        { category: "materials", label: "Materials & supplies", cents: 10000, count: 1 },
        { category: "fuel", label: "Fuel", cents: 7000, count: 2 },
      ],
      owedCents: 6000,
    });
    expect(r.series.reduce((s, b) => s + b.spentCents, 0)).toBe(17000);
  });
});

describe("auto-invoice with billed expenses", () => {
  it("still treats an unpriced job as needing a price", () => {
    const lines = [
      { label: "Shrink wrap — 28ft Sea Ray", unitPriceCents: 0 },
      { label: "Shrink wrap (Home Depot)", unitPriceCents: 10000 },
    ];
    expect(hasUnpricedJobLine({ line_items: lines as never }, "Shrink wrap — 28ft Sea Ray")).toBe(true);
    expect(hasUnpricedJobLine({ line_items: [{ label: "Shrink wrap — 28ft Sea Ray", unitPriceCents: 45000 }] as never }, "Shrink wrap — 28ft Sea Ray")).toBe(false);
  });
});

// ── Service ──────────────────────────────────────────────────────────────────

describe("expense service", () => {
  const input = (over: Record<string, unknown> = {}) => rules.expenseCreateSchema.parse({ spentOn: "2026-10-03", amountCents: 11300, taxCents: 1300, vendor: "Home Depot", ...over });

  it("files a job expense under the job's company and a general one under the only company", async () => {
    const crew = fakeTenantContext(db, ORG, CREW);
    const onJob = await svc.createExpense(crew, "member", input({ bookingId: JOB, billable: true, category: "materials" }));
    expect(onJob).toMatchObject({ companyId: CO, bookingId: JOB, jobTitle: "Shrink wrap — 28ft Sea Ray", billable: true, costCents: 10000, personName: "Lee Park", canEdit: true });
    const general = await svc.createExpense(crew, "member", input({ category: "fuel" }));
    expect(general).toMatchObject({ companyId: CO, bookingId: null, billable: false });

    db.tables.companies.push({ id: CO2, organization_id: ORG, name: "A1 Marine Storage" });
    const unassigned = await svc.createExpense(crew, "member", input({}));
    expect(unassigned.companyId).toBeNull();
  });

  it("checks the receipt belongs to the org and finished uploading", async () => {
    const crew = fakeTenantContext(db, ORG, CREW);
    await expect(svc.createExpense(crew, "member", input({ receipt: { path: `${OTHER_ORG}/d0000000-0000-4000-8000-000000000001.jpg`, type: "image/jpeg" } }))).rejects.toThrow(
      /doesn't belong/,
    );
    await expect(svc.createExpense(crew, "member", input({ receipt: { path: RECEIPT, type: "application/pdf" } }))).rejects.toThrow(/doesn't belong/);
    receiptThere = false;
    await expect(svc.createExpense(crew, "member", input({ receipt: { path: RECEIPT, type: "image/jpeg" } }))).rejects.toThrow(/didn't finish uploading/);
    receiptThere = true;
    const e = await svc.createExpense(crew, "member", input({ receipt: { path: RECEIPT, type: "image/jpeg" } }));
    expect(e.receiptUrl).toBe(`https://signed/${RECEIPT}`);
  });

  it("lets crew change only their own, un-repaid expenses", async () => {
    db.tables.expenses.push(expenseRow({ id: "mine", created_by: CREW }), expenseRow({ id: "theirs", created_by: OWNER }), expenseRow({ id: "repaid", created_by: CREW, paid_with: "personal", reimbursed_at: "2026-10-04T00:00:00Z" }));
    const crew = fakeTenantContext(db, ORG, CREW);
    await expect(svc.updateExpense(crew, "member", "theirs", { amountCents: 100 })).rejects.toThrow(/only change expenses you logged/);
    await expect(svc.updateExpense(crew, "member", "repaid", { amountCents: 100 })).rejects.toThrow(/paid back or billed/);
    await expect(svc.deleteExpense(crew, "member", "repaid")).rejects.toThrow(/paid back or billed/);
    await expect(svc.updateExpense(crew, "member", "mine", { taxCents: 99999 })).rejects.toThrow(/Tax can't be more/);
    const updated = await svc.updateExpense(crew, "member", "mine", { amountCents: 5650, taxCents: 650 });
    expect(updated).toMatchObject({ amountCents: 5650, costCents: 5000 });
    // An owner can fix anything.
    const owner = fakeTenantContext(db, ORG, OWNER);
    expect((await svc.updateExpense(owner, "owner", "repaid", { vendor: "Esso" })).vendor).toBe("Esso");
  });

  it("clears a reimbursement when switched to paid by the business, and drops billing without a job", async () => {
    db.tables.expenses.push(expenseRow({ id: "x", paid_with: "personal", reimbursed_at: "2026-10-04T00:00:00Z", reimbursed_by: OWNER, booking_id: JOB, billable: true }));
    const owner = fakeTenantContext(db, ORG, OWNER);
    const e = await svc.updateExpense(owner, "owner", "x", { paidWith: "business", bookingId: null });
    expect(e).toMatchObject({ paidWith: "business", reimbursedAt: null, bookingId: null, billable: false });
    await expect(svc.updateExpense(owner, "owner", "x", { billable: true })).rejects.toThrow(/Only an expense on a job/);
  });

  it("replacing or deleting removes the old receipt file", async () => {
    const other = `${ORG}/d0000000-0000-4000-8000-000000000002.pdf`;
    db.tables.expenses.push(expenseRow({ id: "r", receipt_path: RECEIPT, receipt_type: "image/jpeg" }));
    const owner = fakeTenantContext(db, ORG, OWNER);
    await svc.updateExpense(owner, "owner", "r", { receipt: { path: other, type: "application/pdf" } });
    expect(removed).toEqual([RECEIPT]);
    await svc.deleteExpense(owner, "owner", "r");
    expect(removed).toEqual([RECEIPT, other]);
    expect(db.tables.expenses).toHaveLength(0);
  });

  it("only owners and admins mark expenses paid back, and only out-of-pocket ones", async () => {
    db.tables.expenses.push(expenseRow({ id: "p1", paid_with: "personal" }), expenseRow({ id: "b1", paid_with: "business" }));
    await expect(svc.setReimbursed(fakeTenantContext(db, ORG, CREW), "member", ["p1"], true)).rejects.toThrow(/Only owners and admins/);
    const owner = fakeTenantContext(db, ORG, OWNER);
    expect(await svc.setReimbursed(owner, "admin", ["p1", "b1"], true, new Date("2026-10-05T12:00:00Z"))).toBe(1);
    expect(db.tables.expenses.find((r) => r.id === "p1")).toMatchObject({ reimbursed_at: "2026-10-05T12:00:00.000Z", reimbursed_by: OWNER });
    expect(db.tables.expenses.find((r) => r.id === "b1")!.reimbursed_at).toBeNull();
    expect(await svc.setReimbursed(owner, "admin", ["p1"], false)).toBe(1);
    expect(db.tables.expenses.find((r) => r.id === "p1")!.reimbursed_at).toBeNull();
  });

  it("lists with filters, search, totals and billed status (voided invoices release the expense)", async () => {
    db.tables.invoices.push({ id: "inv-1", organization_id: ORG, invoice_number: "INV-0007", status: "sent" }, { id: "inv-2", organization_id: ORG, invoice_number: "INV-0008", status: "void" });
    db.tables.expenses.push(
      expenseRow({ id: "a", booking_id: JOB, billable: true, billed_invoice_id: "inv-1", spent_on: "2026-10-02" }),
      expenseRow({ id: "b", booking_id: JOB, billable: true, billed_invoice_id: "inv-2", spent_on: "2026-10-03", vendor: "Rona" }),
      expenseRow({ id: "c", category: "fuel", vendor: "Esso", spent_on: "2026-10-04", paid_with: "personal" }),
      expenseRow({ id: "old", spent_on: "2026-08-01" }),
      expenseRow({ id: "elsewhere", organization_id: OTHER_ORG }),
    );
    const owner = fakeTenantContext(db, ORG, OWNER);
    const all = await svc.listExpenses(owner, "owner", rules.expenseListQuerySchema.parse({ from: "2026-10-01", to: "2026-10-31" }));
    expect(all.expenses.map((e) => e.id)).toEqual(["c", "b", "a"]);
    expect(all.expenses.find((e) => e.id === "a")).toMatchObject({ billedInvoiceId: "inv-1", billedInvoiceNumber: "INV-0007", canEdit: true });
    expect(all.expenses.find((e) => e.id === "b")).toMatchObject({ billedInvoiceId: null });
    expect(all.summary).toMatchObject({ count: 3, totalCents: 33900, onJobsCents: 20000, owedCents: 11300 });
    expect(all.canManage).toBe(true);

    const jobs = await svc.listExpenses(owner, "owner", rules.expenseListQuerySchema.parse({ from: "2026-10-01", to: "2026-10-31", kind: "job" }));
    expect(jobs.expenses.map((e) => e.id)).toEqual(["b", "a"]);
    const search = await svc.listExpenses(owner, "owner", rules.expenseListQuerySchema.parse({ from: "2026-10-01", to: "2026-10-31", q: "rona" }));
    expect(search.expenses.map((e) => e.id)).toEqual(["b"]);
    const owed = await svc.listExpenses(owner, "owner", rules.expenseListQuerySchema.parse({ from: "2026-10-01", to: "2026-10-31", owed: true }));
    expect(owed.expenses.map((e) => e.id)).toEqual(["c"]);

    const crew = await svc.listExpenses(fakeTenantContext(db, ORG, CREW), "member", rules.expenseListQuerySchema.parse({ from: "2026-10-01", to: "2026-10-31" }));
    // (RLS limits crew to their own rows in production; here every row is theirs.)
    expect(crew.expenses.find((e) => e.id === "a")!.canEdit).toBe(false); // billed
    expect(crew.canManage).toBe(false);
  });

  it("exports CSV oldest first", async () => {
    db.tables.expenses.push(expenseRow({ id: "a", spent_on: "2026-10-02", vendor: "First" }), expenseRow({ id: "b", spent_on: "2026-10-04", vendor: "Second", receipt_path: RECEIPT, receipt_type: "image/jpeg" }));
    const csv = await svc.exportExpensesCsv(fakeTenantContext(db, ORG, OWNER), "owner", rules.expenseListQuerySchema.parse({ from: "2026-10-01", to: "2026-10-31" }));
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe(rules.CSV_HEADER.join(","));
    expect(lines[1]).toContain("First");
    expect(lines[2]).toContain("Second");
    expect(lines[2].endsWith(",Yes")).toBe(true);
    expect(lines[1].endsWith(",No")).toBe(true);
  });

  it("turns billable expenses into invoice lines and never fails the invoice", async () => {
    const ctx = fakeTenantContext(db, ORG, CREW);
    const rpc = vi.fn(async (fn: string) =>
      fn === "billable_expenses_for_booking"
        ? {
            data: [
              { id: "e1", vendor: "Home Depot", description: "Shrink wrap", category: "materials", amount_cents: 11300, tax_cents: 1300, spent_on: "2026-10-02" },
              { id: "e2", vendor: null, description: null, category: "other", amount_cents: 500, tax_cents: 500, spent_on: "2026-10-02" },
            ],
            error: null,
          }
        : { data: 1, error: null },
    );
    (db.client as unknown as { rpc: typeof rpc }).rpc = rpc;
    const r = await svc.billableExpenseLines(ctx, JOB);
    expect(r.ids).toEqual(["e1"]); // a $0-before-tax line adds nothing
    expect(r.lines).toEqual([{ label: "Shrink wrap (Home Depot)", description: null, quantity: 1, unitPriceCents: 10000 }]);
    await svc.markExpensesBilled(ctx, "inv-9", r.ids);
    expect(rpc).toHaveBeenLastCalledWith("mark_expenses_billed", { p_invoice_id: "inv-9", p_expense_ids: ["e1"] });

    (db.client as unknown as { rpc: unknown }).rpc = vi.fn(async () => ({ data: null, error: { message: "boom" } }));
    expect(await svc.billableExpenseLines(ctx, JOB)).toEqual({ ids: [], lines: [] });
  });
});

describe("reading a receipt with AI", () => {
  it("sends a photo as an image and a PDF as a document, and cleans the answer", async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test";
    try {
      aiAnswer = JSON.stringify({ vendor: "Rona", date: "2026-10-04", totalCents: 11300, taxCents: 1300, category: "materials", description: "Lumber" });
      const photo = await readReceipt({ bytes: Buffer.from("jpg"), type: "image/jpeg" }, "2026-10-05");
      expect(photo.scan).toEqual({ vendor: "Rona", spentOn: "2026-10-04", amountCents: 11300, taxCents: 1300, category: "materials", description: "Lumber" });
      const content = (aiCalls.at(-1)!.messages as Array<{ content: Array<{ type: string; source?: { media_type: string; data: string } }> }>)[0].content;
      expect(content[0]).toMatchObject({ type: "image", source: { media_type: "image/jpeg", data: Buffer.from("jpg").toString("base64") } });

      aiAnswer = JSON.stringify({ vendor: null, date: "1999-01-01", totalCents: 500, taxCents: 900, category: "nope", description: null });
      const pdf = await readReceipt({ bytes: Buffer.from("%PDF"), type: "application/pdf" }, "2026-10-05");
      const pdfContent = (aiCalls.at(-1)!.messages as Array<{ content: Array<{ type: string }> }>)[0].content;
      expect(pdfContent[0].type).toBe("document");
      expect(pdf.scan).toMatchObject({ spentOn: null, amountCents: 500, taxCents: null, category: null });

      delete process.env.ANTHROPIC_API_KEY;
      await expect(readReceipt({ bytes: Buffer.from("x"), type: "image/jpeg" }, "2026-10-05")).rejects.toBeInstanceOf(ReceiptReadingUnavailableError);
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});
