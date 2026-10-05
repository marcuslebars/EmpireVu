import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "./fake-supabase";

process.env.ACCOUNTING_TOKEN_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.QUICKBOOKS_CLIENT_ID = "qb-id";
process.env.QUICKBOOKS_CLIENT_SECRET = "qb-secret";
process.env.XERO_CLIENT_ID = "x-id";
process.env.XERO_CLIENT_SECRET = "x-secret";

// ── Engine wiring: a fake provider + a fake session, everything else real ─────
let db: FakeDb;
const calls: Array<{ fn: string; args: unknown[] }> = [];
let failNext: Error | null = null;
const receipts = new Map<string, { bytes: Buffer; type: "image/jpeg" | "application/pdf" }>();

vi.mock("@/server/supabase/admin", () => ({ createSupabaseAdminClient: () => db.client }));
vi.mock("@/server/services/accounting/tokens", () => ({
  sessionFor: vi.fn(async () => ({ tenantId: "realm-1", accessToken: "tok", environment: "production", fetch })),
  saveTokens: vi.fn(),
  readTokens: vi.fn(),
}));
vi.mock("@/server/services/expenses/receipts", () => ({
  downloadReceipt: vi.fn(async (_org: string, path: string) => {
    const f = receipts.get(path);
    if (!f) throw new Error("missing");
    return f;
  }),
}));

let seq = 0;
const fakeProvider = {
  id: "quickbooks" as const,
  record(fn: string, ...args: unknown[]) {
    calls.push({ fn, args });
    if (failNext) {
      const e = failNext;
      failNext = null;
      throw e;
    }
  },
  authorizeUrl: () => "",
  exchangeCode: vi.fn(),
  refresh: vi.fn(),
  revoke: vi.fn(),
  options: vi.fn(),
  async findOrCreateCustomer(_s: unknown, c: { key: string; name: string }, taken: Set<string>) {
    fakeProvider.record("customer", c.name, [...taken]);
    return { id: `cust-${++seq}`, version: "0" };
  },
  async findOrCreateVendor(_s: unknown, name: string) {
    fakeProvider.record("vendor", name);
    return { id: `vend-${++seq}`, version: "0" };
  },
  async pushInvoice(_s: unknown, doc: { totalCents: number; lines: unknown[] }, customer: { id: string }, _st: unknown, existing: { id: string } | null) {
    fakeProvider.record("pushInvoice", doc, customer.id, existing?.id ?? null);
    return { id: existing?.id ?? `inv-${++seq}`, version: "1", totalCents: doc.totalCents };
  },
  async voidInvoice(_s: unknown, existing: { id: string }) {
    fakeProvider.record("voidInvoice", existing.id);
  },
  async pushPayment(_s: unknown, doc: { amountCents: number; localKey: string }, invoice: { id: string }, _c: unknown, _st: unknown, existing: { id: string } | null) {
    fakeProvider.record("pushPayment", doc.localKey, doc.amountCents, invoice.id, existing?.id ?? null);
    return { id: existing?.id ?? `pay-${++seq}`, version: "0", totalCents: doc.amountCents };
  },
  async deletePayment(_s: unknown, existing: { id: string }) {
    fakeProvider.record("deletePayment", existing.id);
  },
  async pushExpense(_s: unknown, doc: { netCents: number }, vendor: { id: string } | null, _st: unknown, existing: { id: string } | null) {
    fakeProvider.record("pushExpense", doc.netCents, vendor?.id ?? null, existing?.id ?? null);
    return { id: existing?.id ?? `exp-${++seq}`, version: "0", totalCents: null };
  },
  async deleteExpense(_s: unknown, existing: { id: string }) {
    fakeProvider.record("deleteExpense", existing.id);
  },
  async attachReceipt(_s: unknown, expense: { id: string }, file: { fileName: string; contentType: string }) {
    fakeProvider.record("attachReceipt", expense.id, file.fileName, file.contentType);
  },
};
vi.mock("@/server/services/accounting/providers", () => ({ providerFor: () => fakeProvider }));

const { encryptSecret, decryptSecret, signState, verifyState } = await import("@/server/services/accounting/crypto");
const mapping = await import("@/server/services/accounting/mapping");
const { suggestSettings } = await import("@/server/services/accounting/suggest");
const types = await import("@/server/services/accounting/types");
const { tokenRequest } = await import("@/server/services/accounting/http");
const engine = await import("@/server/services/accounting/engine");
// The real providers, bypassing the mock above.
const { quickbooks } = await vi.importActual<typeof import("@/server/services/accounting/providers/quickbooks")>("@/server/services/accounting/providers/quickbooks");
const { xero, pickTenant } = await vi.importActual<typeof import("@/server/services/accounting/providers/xero")>("@/server/services/accounting/providers/xero");

const { ProviderError, missingSettings, parseSettings } = types;

// ── Crypto ───────────────────────────────────────────────────────────────────

describe("token encryption and OAuth state", () => {
  it("round-trips, and refuses tampered ciphertext", () => {
    const blob = encryptSecret("refresh-token-xyz");
    expect(blob).not.toContain("refresh-token");
    expect(decryptSecret(blob)).toBe("refresh-token-xyz");
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
    const parts = blob.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptSecret(parts.join("."))).toThrow();
  });

  it("signs state bound to the owner and company, and rejects forged / expired / foreign ones", () => {
    const s = signState({ provider: "xero", organizationId: "org", companyId: "co", profileId: "me" }, 1_000);
    expect(verifyState(s, 2_000)).toMatchObject({ provider: "xero", organizationId: "org", companyId: "co", profileId: "me" });
    expect(verifyState(s, 1_000 + 16 * 60_000)).toBeNull();
    const [payload, sig] = s.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), companyId: "other" })).toString("base64url");
    expect(verifyState(`${forged}.${sig}`, 2_000)).toBeNull();
    expect(verifyState("garbage", 2_000)).toBeNull();
    expect(verifyState(null)).toBeNull();
  });
});

// ── Mapping ──────────────────────────────────────────────────────────────────

const INV = {
  id: "11111111-1111-4111-8111-111111111111",
  status: "sent",
  invoice_number: "INV-0007",
  title: "Spring launch",
  currency: "CAD",
  line_items: [
    { label: "Launch", description: "28ft", quantity: 1, unitPriceCents: 33333, amountCents: 33333 },
    { label: "Bottom wash", quantity: 2, unitPriceCents: 10001, amountCents: 20002 },
    { label: "Loyalty discount", quantity: 1, unitPriceCents: -3335, amountCents: -3335 },
  ],
  subtotal_cents: 50000,
  tax_rate_bps: 1300,
  tax_cents: 6500,
  total_cents: 56500,
  credit_cents: 0,
  issue_date: "2026-10-05",
  due_date: "2026-10-19",
  sent_at: "2026-10-05T14:00:00Z",
  created_at: "2026-10-04T14:00:00Z",
  contact_id: "c1",
  customer_account_id: null,
  bill_to: { name: "  Pat   Smith ", company: "Smith Marine", email: "pat@example.com", phone: "555", address: "1 Dock Rd" },
};

describe("mapping", () => {
  it("splits the invoice tax across lines so the parts add up exactly", () => {
    for (const [amounts, tax] of [
      [[33333, 20002, -3335], 6500],
      [[1, 1, 1], 1],
      [[10000], 1300],
      [[99, 1], 13],
    ] as Array<[number[], number]>) {
      const parts = mapping.allocateTax(amounts, amounts.map(() => true), tax);
      expect(parts.reduce((s, x) => s + x, 0)).toBe(tax);
    }
    expect(mapping.allocateTax([100, 100], [true, false], 13)).toEqual([13, 0]);
    expect(mapping.allocateTax([100], [true], 0)).toEqual([0]);
  });

  it("builds the invoice document", () => {
    const doc = mapping.invoiceDoc(INV, { timeZone: "America/Toronto", depositAsLine: false });
    expect(doc).toMatchObject({ number: "INV-0007", issueDate: "2026-10-05", dueDate: "2026-10-19", subtotalCents: 50000, taxCents: 6500, totalCents: 56500, voided: false });
    expect(doc.lines.map((l) => l.description)).toEqual(["Launch — 28ft", "Bottom wash", "Loyalty discount"]);
    expect(doc.lines.reduce((s, l) => s + l.taxCents, 0)).toBe(6500);
    expect(doc.lines.every((l) => l.taxable)).toBe(true);
  });

  it("an online-booking deposit becomes an untaxed negative line; a 0% invoice is untaxed", () => {
    const doc = mapping.invoiceDoc({ ...INV, credit_cents: 5000 }, { timeZone: "America/Toronto", depositAsLine: true, depositInvoiceNumber: "INV-0003" });
    const dep = doc.lines.at(-1)!;
    expect(dep).toMatchObject({ description: "Deposit received (invoice INV-0003)", amountCents: -5000, taxable: false, taxCents: 0 });
    expect(doc.totalCents).toBe(51500);
    expect(doc.taxCents).toBe(6500);
    const bare = mapping.invoiceDoc({ ...INV, line_items: [], subtotal_cents: 50000, tax_cents: 0, tax_rate_bps: 0, total_cents: 50000 }, { timeZone: "UTC", depositAsLine: false });
    expect(bare.lines).toEqual([{ description: "Spring launch", quantity: 1, unitPriceCents: 50000, amountCents: 50000, taxable: false, taxCents: 0 }]);
    const untaxed = mapping.invoiceDoc({ ...INV, tax_rate_bps: 0, tax_cents: 0, total_cents: 50000 }, { timeZone: "UTC", depositAsLine: false });
    expect(untaxed.lines.every((l) => !l.taxable && l.taxCents === 0)).toBe(true);
  });

  it("names customers by person or business, with a tie-breaker name", () => {
    expect(mapping.customerDoc(INV)).toMatchObject({ key: "contact:c1", name: "Pat Smith", alternateName: "Pat Smith (pat@example.com)", email: "pat@example.com" });
    expect(mapping.customerDoc({ ...INV, customer_account_id: "a1" })).toMatchObject({ key: "account:a1", name: "Smith Marine" });
    expect(mapping.customerDoc({ ...INV, bill_to: {} }).name).toBe("Customer");
  });

  it("dates payments in the company's time zone and turns a quote deposit into a payment", () => {
    const p = mapping.paymentDoc({ id: "p1", invoice_id: INV.id, amount_cents: 2500, method: "etransfer", reference: "CA123", received_at: "2026-10-06T02:30:00Z" }, "America/Toronto");
    expect(p).toMatchObject({ date: "2026-10-05", memo: "e-Transfer via EmpireVu (CA123)", reference: "CA123" });
    expect(mapping.depositPaymentDoc({ ...INV, credit_cents: 5000 }, "2026-09-30T15:00:00Z", "America/Toronto")).toMatchObject({ localKey: `deposit:${INV.id}`, amountCents: 5000, date: "2026-09-30" });
  });

  it("expenses go over net of tax, and hashes ignore key order", () => {
    expect(mapping.expenseDoc({ id: "e", spent_on: "2026-10-03", vendor: "Rona", description: null, category: "materials", amount_cents: 11300, tax_cents: 1300, paid_with: "personal" })).toMatchObject({
      description: "Rona",
      netCents: 10000,
      taxCents: 1300,
      personal: true,
    });
    expect(mapping.docHash({ a: 1, b: [2, { c: 3, d: 4 }] })).toBe(mapping.docHash({ b: [2, { d: 4, c: 3 }], a: 1 }));
    expect(mapping.docHash({ a: 1 })).not.toBe(mapping.docHash({ a: 2 }));
  });
});

describe("settings", () => {
  it("lists what's missing, without tax codes for US QuickBooks", () => {
    const blank = parseSettings({});
    expect(missingSettings(blank, "quickbooks").invoices).toEqual(["Product/service for invoice lines", "Sales tax code", "No-tax code", "Account payments go to"]);
    expect(missingSettings({ ...blank, country: "US" }, "quickbooks").invoices).toEqual(["Product/service for invoice lines", "Account payments go to"]);
    expect(missingSettings(blank, "xero").expenses).toContain("Purchase tax code");
    expect(parseSettings({ syncInvoices: "nope" })).toEqual(parseSettings({}));
  });

  it("suggests a mapping from the file's own names, never overriding a choice", () => {
    const r = (id: string, name: string, kind?: string) => ({ id, name, kind });
    const options = {
      incomeTargets: [r("1", "Hours"), r("2", "Services")],
      salesTaxCodes: [r("3", "Exempt"), r("4", "HST ON"), r("5", "GST")],
      purchaseTaxCodes: [r("4", "HST ON"), r("6", "Zero-rated")],
      depositAccounts: [r("7", "Chequing", "Bank"), r("8", "Undeposited Funds", "Other Current Asset")],
      paidFromAccounts: [r("7", "Chequing", "Bank"), r("9", "Visa", "Credit Card")],
      expenseAccounts: [r("10", "Supplies"), r("11", "Automobile Expense:Fuel"), r("12", "Insurance"), r("13", "Advertising & Marketing"), r("14", "General expenses")],
    };
    const s = suggestSettings(options, "quickbooks", parseSettings({ paymentAccount: r("7", "Chequing") }));
    expect(s).toMatchObject({
      incomeTarget: { id: "2" },
      salesTaxCode: { id: "4" },
      salesExemptCode: { id: "3" },
      purchaseTaxCode: { id: "4" },
      purchaseExemptCode: { id: "6" },
      paidFromBusiness: { id: "7" },
      expenseFallbackAccount: { id: "14" },
    });
    expect(s.paymentAccount).toBeUndefined();
    expect(s.expenseAccounts).toMatchObject({ materials: { id: "10" }, fuel: { id: "11" }, insurance: { id: "12" }, marketing: { id: "13" } });
  });
});

// ── Providers against a scripted HTTP server ─────────────────────────────────

type Handler = (req: { method: string; url: URL; headers: Headers; body: string | FormData | null }) => { status?: number; json?: unknown; headers?: Record<string, string> };

function server(handler: Handler) {
  const seen: Array<{ method: string; url: URL; body: unknown; headers: Headers }> = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const raw = init?.body ?? null;
    const body = typeof raw === "string" ? raw : raw instanceof FormData ? raw : raw ? "[binary]" : null;
    seen.push({ method, url, body: typeof body === "string" ? (body.startsWith("{") ? JSON.parse(body) : body) : body, headers });
    const r = handler({ method, url, headers, body: body as string | FormData | null });
    return new Response(r.json === undefined ? "" : JSON.stringify(r.json), { status: r.status ?? 200, headers: r.headers });
  }) as typeof fetch;
  return { f, seen };
}

const ST = parseSettings({
  incomeTarget: { id: "item-9", name: "Services" },
  salesTaxCode: { id: "13", name: "HST ON" },
  salesExemptCode: { id: "2", name: "Exempt" },
  paymentAccount: { id: "acc-uf", name: "Undeposited Funds" },
  expenseFallbackAccount: { id: "acc-gen", name: "General" },
  expenseAccounts: { fuel: { id: "acc-fuel", name: "Fuel" } },
  purchaseTaxCode: { id: "13", name: "HST ON" },
  purchaseExemptCode: { id: "2", name: "Exempt" },
  paidFromBusiness: { id: "acc-visa", name: "Visa", kind: "Credit Card" },
  country: "CA",
});

describe("QuickBooks", () => {
  const doc = () => mapping.invoiceDoc({ ...INV, line_items: [...INV.line_items, { label: "Hours", quantity: 1.333, unitPriceCents: 7500, amountCents: 9998 }] }, { timeZone: "UTC", depositAsLine: false });

  it("creates an invoice with tax codes, TaxExcluded and a safe quantity", async () => {
    const { f, seen } = server(() => ({ json: { Invoice: { Id: "77", SyncToken: "0", TotalAmt: 677.48 } } }));
    const r = await quickbooks.pushInvoice({ tenantId: "realm", accessToken: "t", environment: "sandbox", fetch: f }, doc(), { id: "cust-1", version: null }, ST, null);
    expect(r).toEqual({ id: "77", version: "0", totalCents: 67748 });
    const req = seen[0];
    expect(req.method).toBe("POST");
    expect(req.url.toString()).toContain("https://sandbox-quickbooks.api.intuit.com/v3/company/realm/invoice");
    expect(req.url.searchParams.get("minorversion")).toBe("75");
    expect(req.headers.get("authorization")).toBe("Bearer t");
    const body = req.body as { Line: Array<{ Amount: number; SalesItemLineDetail: { Qty: number; UnitPrice: number; TaxCodeRef: { value: string }; ItemRef: { value: string } } }>; GlobalTaxCalculation: string; DocNumber: string; CustomerRef: { value: string } };
    expect(body).toMatchObject({ GlobalTaxCalculation: "TaxExcluded", DocNumber: "INV-0007", CustomerRef: { value: "cust-1" } });
    expect(body.Line[0].SalesItemLineDetail).toMatchObject({ Qty: 1, UnitPrice: 333.33, TaxCodeRef: { value: "13" }, ItemRef: { value: "item-9" } });
    expect(body.Line[1].SalesItemLineDetail).toMatchObject({ Qty: 2, UnitPrice: 100.01 });
    expect(body.Line[2].Amount).toBe(-33.35);
    // 1.333 × $75 = $99.975 ≠ $99.98 → sent as 1 × $99.98 so QuickBooks' own check passes.
    expect(body.Line[3]).toMatchObject({ Amount: 99.98, SalesItemLineDetail: { Qty: 1, UnitPrice: 99.98 } });
  });

  it("updates sparsely with a fresh SyncToken, and US files use TAX/NON without TaxExcluded", async () => {
    const { f, seen } = server(({ method }) => (method === "GET" ? { json: { Invoice: { Id: "77", SyncToken: "4" } } } : { json: { Invoice: { Id: "77", SyncToken: "5", TotalAmt: 1 } } }));
    await quickbooks.pushInvoice({ tenantId: "realm", accessToken: "t", environment: "production", fetch: f }, doc(), { id: "c", version: null }, { ...ST, country: "US" }, { id: "77", version: "1" });
    expect(seen[0].method).toBe("GET");
    const body = seen[1].body as Record<string, unknown> & { Line: Array<{ SalesItemLineDetail: { TaxCodeRef: { value: string } } }> };
    expect(body).toMatchObject({ Id: "77", SyncToken: "4", sparse: true });
    expect(body.GlobalTaxCalculation).toBeUndefined();
    expect(body.Line[0].SalesItemLineDetail.TaxCodeRef).toEqual({ value: "TAX" });
    expect(seen[1].url.host).toBe("quickbooks.api.intuit.com");
  });

  it("re-creates a record deleted in QuickBooks instead of failing forever", async () => {
    const { f, seen } = server(({ method }) =>
      method === "GET" ? { status: 400, json: { Fault: { Error: [{ Message: "Object Not Found", code: "610" }] } } } : { json: { Invoice: { Id: "88", SyncToken: "0" } } },
    );
    const r = await quickbooks.pushInvoice({ tenantId: "realm", accessToken: "t", environment: "production", fetch: f }, doc(), { id: "c", version: null }, ST, { id: "77", version: "1" });
    expect(r.id).toBe("88");
    expect((seen[1].body as Record<string, unknown>).Id).toBeUndefined();
  });

  it("finds a customer by name, skips one already linked elsewhere, and survives a name taken by a vendor", async () => {
    const created: string[] = [];
    const { f } = server(({ method, url, body }) => {
      if (method === "GET") {
        const sql = url.searchParams.get("query") ?? "";
        if (sql.includes("'Pat Smith'")) return { json: { QueryResponse: { Customer: [{ Id: "5", DisplayName: "Pat Smith", SyncToken: "0" }] } } };
        return { json: { QueryResponse: {} } };
      }
      const name = JSON.parse(body as string).DisplayName as string;
      created.push(name);
      if (name === "Pat Smith (pat@example.com)") return { status: 400, json: { Fault: { Error: [{ Message: "Duplicate Name Exists Error", code: "6240" }] } } };
      return { json: { Customer: { Id: "6", SyncToken: "0" } } };
    });
    const s = { tenantId: "r", accessToken: "t", environment: "production" as const, fetch: f };
    const c = mapping.customerDoc(INV);
    expect(await quickbooks.findOrCreateCustomer(s, c, new Set())).toEqual({ id: "5", version: "0" });
    expect(await quickbooks.findOrCreateCustomer(s, c, new Set(["5"]))).toEqual({ id: "6", version: "0" });
    expect(created).toEqual(["Pat Smith (pat@example.com)", "Pat Smith (customer)"]);
  });

  it("escapes quotes in names", async () => {
    const { f, seen } = server(() => ({ json: { QueryResponse: { Vendor: [{ Id: "1", SyncToken: "0" }] } } }));
    await quickbooks.findOrCreateVendor({ tenantId: "r", accessToken: "t", environment: "production", fetch: f }, "Bob's Marine");
    expect(seen[0].url.searchParams.get("query")).toBe("select Id, SyncToken, DisplayName from Vendor where DisplayName = 'Bob\\'s Marine'");
  });

  it("records payments against the invoice, and expenses as Purchases (card vs cash)", async () => {
    const { f, seen } = server(({ url }) => (url.pathname.endsWith("/payment") ? { json: { Payment: { Id: "p", SyncToken: "0", TotalAmt: 25 } } } : { json: { Purchase: { Id: "x", SyncToken: "0", TotalAmt: 113 } } }));
    const s = { tenantId: "r", accessToken: "t", environment: "production" as const, fetch: f };
    await quickbooks.pushPayment(s, mapping.paymentDoc({ id: "p1", invoice_id: "i", amount_cents: 2500, method: "card", reference: "ch_123456789012345678901234", received_at: "2026-10-05T12:00:00Z" }, "UTC"), { id: "77", version: "0" }, { id: "c", version: null }, ST, null);
    expect(seen[0].body).toMatchObject({ TotalAmt: 25, TxnDate: "2026-10-05", DepositToAccountRef: { value: "acc-uf" }, Line: [{ Amount: 25, LinkedTxn: [{ TxnId: "77", TxnType: "Invoice" }] }] });
    expect(((seen[0].body as { PaymentRefNum: string }).PaymentRefNum).length).toBeLessThanOrEqual(21);
    const exp = mapping.expenseDoc({ id: "e", spent_on: "2026-10-03", vendor: "Esso", description: null, category: "fuel", amount_cents: 11300, tax_cents: 1300, paid_with: "business" });
    await quickbooks.pushExpense(s, exp, { id: "v", version: null }, ST, null);
    expect(seen[1].body).toMatchObject({
      PaymentType: "CreditCard",
      AccountRef: { value: "acc-visa" },
      EntityRef: { value: "v", type: "Vendor" },
      GlobalTaxCalculation: "TaxExcluded",
      Line: [{ Amount: 100, AccountBasedExpenseLineDetail: { AccountRef: { value: "acc-fuel" }, TaxCodeRef: { value: "13" } } }],
    });
    await quickbooks.pushExpense(s, { ...exp, category: "meals", taxCents: 0, netCents: 11300 }, null, { ...ST, paidFromBusiness: { id: "chq", name: "Chequing", kind: "Bank" } }, null);
    expect(seen[2].body).toMatchObject({ PaymentType: "Cash", Line: [{ Amount: 113, AccountBasedExpenseLineDetail: { AccountRef: { value: "acc-gen" }, TaxCodeRef: { value: "2" } } }] });
    expect((seen[2].body as Record<string, unknown>).EntityRef).toBeUndefined();
  });

  it("voids / deletes with the current SyncToken and treats an already-gone record as done", async () => {
    const { f, seen } = server(({ method, url }) => {
      if (method === "GET") return url.pathname.endsWith("/payment/9") ? { status: 400, json: { Fault: { Error: [{ Message: "Object Not Found", code: "610" }] } } } : { json: { Invoice: { Id: "77", SyncToken: "3" } } };
      return { json: { Invoice: { Id: "77" } } };
    });
    const s = { tenantId: "r", accessToken: "t", environment: "production" as const, fetch: f };
    await quickbooks.voidInvoice(s, { id: "77", version: "0" });
    expect(seen[1].url.searchParams.get("operation")).toBe("void");
    expect(seen[1].body).toEqual({ Id: "77", SyncToken: "3" });
    await quickbooks.deletePayment(s, { id: "9", version: "0" });
    expect(seen).toHaveLength(3);
  });

  it("attaches a receipt as multipart to the Purchase", async () => {
    const { f, seen } = server(() => ({ json: { AttachableResponse: [] } }));
    await quickbooks.attachReceipt({ tenantId: "r", accessToken: "t", environment: "production", fetch: f }, { id: "x", version: null }, { bytes: Buffer.from("jpg"), contentType: "image/jpeg", fileName: "receipt.jpg" });
    expect(seen[0].url.pathname).toBe("/v3/company/r/upload");
    const form = seen[0].body as FormData;
    // (jsdom's File: read it the browser way)
    const read = (b: Blob) => new Promise<string>((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.readAsText(b);
    });
    const meta = JSON.parse(await read(form.get("file_metadata_01") as Blob));
    expect(meta).toMatchObject({ AttachableRef: [{ EntityRef: { type: "Purchase", value: "x" } }], FileName: "receipt.jpg" });
    expect(await read(form.get("file_content_01") as Blob)).toBe("jpg");
  });

  it("turns errors into retryable / reauth / human ones", async () => {
    const s = (status: number, json: unknown, headers?: Record<string, string>) => ({ tenantId: "r", accessToken: "t", environment: "production" as const, fetch: server(() => ({ status, json, headers })).f });
    await expect(quickbooks.voidInvoice(s(429, {}, { "retry-after": "30" }), { id: "1", version: "0" })).rejects.toMatchObject({ retryable: true, opts: { retryAfterSeconds: 30 } });
    await expect(quickbooks.voidInvoice(s(401, { Fault: { Error: [{ Message: "AuthenticationFailed", code: "100" }] } }), { id: "1", version: "0" })).rejects.toMatchObject({ reauth: true });
    const err = await quickbooks
      .pushInvoice(s(400, { Fault: { Error: [{ Message: "Invalid Reference Id", Detail: "Invalid Reference Id : Item assigned to this transaction has been deleted", code: "2500" }] } }), doc(), { id: "c", version: null }, ST, null)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toBe("QuickBooks: Invalid Reference Id : Item assigned to this transaction has been deleted [2500]");
    expect(err.retryable || err.reauth).toBe(false);
  });

  it("exchanges the code with Basic auth and reads the company", async () => {
    const { f, seen } = server(({ url }) => {
      if (url.pathname.endsWith("/bearer")) return { json: { access_token: "a", refresh_token: "r", expires_in: 3600, x_refresh_token_expires_in: 8_640_000 } };
      if (url.pathname.includes("companyinfo")) return { json: { CompanyInfo: { CompanyName: "A1 Marine Care", Country: "CA" } } };
      return { json: { Preferences: { CurrencyPrefs: { HomeCurrency: { value: "CAD" } } } } };
    });
    const r = await quickbooks.exchangeCode({ code: "abc", redirectUri: "https://app/cb", query: new URLSearchParams({ realmId: "123" }) }, f);
    expect(r.file).toEqual({ tenantId: "123", name: "A1 Marine Care", country: "CA", currency: "CAD" });
    expect(r.tokens.refreshExpiresAt).not.toBeNull();
    expect(seen[0].headers.get("authorization")).toBe(`Basic ${Buffer.from("qb-id:qb-secret").toString("base64")}`);
    expect(seen[0].body).toBe("grant_type=authorization_code&code=abc&redirect_uri=https%3A%2F%2Fapp%2Fcb");
    await expect(quickbooks.exchangeCode({ code: "abc", redirectUri: "x", query: new URLSearchParams() }, f)).rejects.toThrow(/which company/);
  });

  it("a dead refresh token asks to reconnect", async () => {
    const { f } = server(() => ({ status: 400, json: { error: "invalid_grant" } }));
    await expect(tokenRequest(f, "https://x/token", "Basic x", { grant_type: "refresh_token" })).rejects.toMatchObject({ reauth: true });
  });

  it("classifies the file's lists for the mapping form", async () => {
    const { f } = server(({ url }) => {
      const sql = url.searchParams.get("query") ?? "";
      if (sql.includes("from Item")) return { json: { QueryResponse: { Item: [{ Id: "1", Name: "Services", Type: "Service" }, { Id: "2", Name: "Parts", Type: "Inventory" }] } } };
      if (sql.includes("from TaxCode"))
        return {
          json: {
            QueryResponse: {
              TaxCode: [
                { Id: "13", Name: "HST ON", SalesTaxRateList: { TaxRateDetail: [{}] }, PurchaseTaxRateList: { TaxRateDetail: [{}] } },
                { Id: "9", Name: "Out of scope", SalesTaxRateList: { TaxRateDetail: [] } },
              ],
            },
          },
        };
      return {
        json: {
          QueryResponse: {
            Account: [
              { Id: "a", Name: "Chequing", AccountType: "Bank" },
              { Id: "b", Name: "Undeposited Funds", AccountType: "Other Current Asset", AccountSubType: "UndepositedFunds" },
              { Id: "c", Name: "Visa", AccountType: "Credit Card" },
              { Id: "d", Name: "Fuel", AccountType: "Expense", FullyQualifiedName: "Auto:Fuel" },
              { Id: "e", Name: "Sales", AccountType: "Income" },
            ],
          },
        },
      };
    });
    const o = await quickbooks.options({ tenantId: "r", accessToken: "t", environment: "production", fetch: f });
    expect(o.incomeTargets.map((x) => x.id)).toEqual(["1"]);
    expect(o.salesTaxCodes.map((x) => x.id)).toEqual(["13"]);
    expect(o.depositAccounts.map((x) => x.id)).toEqual(["a", "b"]);
    expect(o.paidFromAccounts.map((x) => [x.id, x.kind])).toEqual([
      ["a", "Bank"],
      ["c", "Credit Card"],
    ]);
    expect(o.expenseAccounts).toEqual([{ id: "d", name: "Auto:Fuel", kind: "Expense" }]);
  });
});

describe("Xero", () => {
  const XS = { ...ST, incomeTarget: { id: "200", name: "200 · Sales" }, salesTaxCode: { id: "OUTPUT2", name: "13% HST" }, salesExemptCode: { id: "EXEMPTOUTPUT", name: "Exempt" }, paymentAccount: { id: "bank-guid", name: "Chequing" }, paidFromBusiness: { id: "bank-guid", name: "Chequing" } };
  const s = (f: typeof fetch) => ({ tenantId: "tenant-1", accessToken: "t", environment: "production" as const, fetch: f });

  it("sends tax-exclusive lines with our own tax amounts so totals match exactly", async () => {
    const { f, seen } = server(() => ({ json: { Invoices: [{ InvoiceID: "9b2f2c1e-0000-4000-8000-000000000001", Total: 565 }] } }));
    const doc = mapping.invoiceDoc(INV, { timeZone: "UTC", depositAsLine: false });
    const r = await xero.pushInvoice(s(f), doc, { id: "contact-1", version: null }, XS, null);
    expect(r.totalCents).toBe(56500);
    expect(seen[0].headers.get("xero-tenant-id")).toBe("tenant-1");
    const inv = (seen[0].body as { Invoices: Array<Record<string, unknown> & { LineItems: Array<{ TaxAmount: number; AccountCode: string; TaxType: string }> }> }).Invoices[0];
    expect(inv).toMatchObject({ Type: "ACCREC", Status: "AUTHORISED", LineAmountTypes: "Exclusive", InvoiceNumber: "INV-0007", Contact: { ContactID: "contact-1" }, Date: "2026-10-05", DueDate: "2026-10-19" });
    expect(inv.InvoiceID).toBeUndefined();
    expect(inv.LineItems.reduce((t, l) => t + Math.round(l.TaxAmount * 100), 0)).toBe(6500);
    expect(inv.LineItems[0]).toMatchObject({ AccountCode: "200", TaxType: "OUTPUT2" });
  });

  it("payments can't be edited in Xero, so a change deletes and re-creates", async () => {
    const { f, seen } = server(({ method }) => (method === "PUT" ? { json: { Payments: [{ PaymentID: "new", Amount: 25 }] } } : { json: { Payments: [{}] } }));
    const r = await xero.pushPayment(s(f), mapping.paymentDoc({ id: "p", invoice_id: "i", amount_cents: 2500, method: "cash", reference: null, received_at: "2026-10-05T12:00:00Z" }, "UTC"), { id: "inv", version: null }, { id: "c", version: null }, XS, { id: "old", version: null });
    expect(seen.map((x) => `${x.method} ${x.url.pathname.split("2.0/")[1]}`)).toEqual(["POST Payments/old", "PUT Payments"]);
    expect(seen[0].body).toEqual({ Status: "DELETED" });
    expect(seen[1].body).toMatchObject({ Payments: [{ Invoice: { InvoiceID: "inv" }, Account: { AccountID: "bank-guid" }, Amount: 25, Date: "2026-10-05" }] });
    expect(r.id).toBe("new");
  });

  it("books an expense as a SPEND bank transaction and attaches the receipt", async () => {
    const { f, seen } = server(() => ({ json: { BankTransactions: [{ BankTransactionID: "bt-1", Total: 113 }] } }));
    const exp = mapping.expenseDoc({ id: "e", spent_on: "2026-10-03", vendor: "Esso", description: null, category: "fuel", amount_cents: 11300, tax_cents: 1300, paid_with: "business" });
    await xero.pushExpense(s(f), exp, { id: "contact-esso", version: null }, { ...XS, purchaseTaxCode: { id: "INPUT2", name: "HST on purchases" } }, null);
    expect(seen[0].body).toMatchObject({
      BankTransactions: [{ Type: "SPEND", Contact: { ContactID: "contact-esso" }, BankAccount: { AccountID: "bank-guid" }, LineItems: [{ UnitAmount: 100, TaxAmount: 13, AccountCode: "acc-fuel", TaxType: "INPUT2" }] }],
    });
    await expect(xero.pushExpense(s(f), exp, null, XS, null)).rejects.toThrow(/contact/);
    await xero.attachReceipt(s(f), { id: "bt-1", version: null }, { bytes: Buffer.from("pdf"), contentType: "application/pdf", fileName: "receipt 1.pdf" });
    expect(seen.at(-1)).toMatchObject({ method: "PUT" });
    expect(seen.at(-1)!.url.pathname).toBe("/api.xro/2.0/BankTransactions/bt-1/Attachments/receipt%201.pdf");
    expect(seen.at(-1)!.headers.get("content-type")).toBe("application/pdf");
  });

  it("reads validation errors and picks the organisation this sign-in was for", async () => {
    const { f } = server(() => ({ status: 400, json: { Elements: [{ ValidationErrors: [{ Message: "Account code '999' is not a valid code." }] }] } }));
    await expect(xero.pushInvoice(s(f), mapping.invoiceDoc(INV, { timeZone: "UTC", depositAsLine: false }), { id: "c", version: null }, XS, null)).rejects.toThrow("Xero: Account code '999' is not a valid code.");
    const token = `x.${Buffer.from(JSON.stringify({ authentication_event_id: "ev-2" })).toString("base64url")}.y`;
    const conns = [
      { tenantId: "t1", tenantType: "ORGANISATION", authEventId: "ev-1", createdDateUtc: "2026-10-05T10:00:00" },
      { tenantId: "t2", tenantType: "ORGANISATION", authEventId: "ev-2", createdDateUtc: "2026-10-01T10:00:00" },
      { tenantId: "p", tenantType: "PRACTICEMANAGER", authEventId: "ev-2" },
    ];
    expect(pickTenant(conns, token)?.tenantId).toBe("t2");
    expect(pickTenant(conns, "not-a-jwt")?.tenantId).toBe("t1");
  });

  it("finds an existing contact by exact name (escaping quotes)", async () => {
    const { f, seen } = server(() => ({ json: { Contacts: [{ ContactID: "k1", Name: 'Bob "Boats"' }] } }));
    expect(await xero.findOrCreateVendor(s(f), 'Bob "Boats"')).toEqual({ id: "k1", version: null });
    expect(decodeURIComponent(seen[0].url.search)).toContain('where=Name=="Bob \\"Boats\\""');
  });
});

// ── Engine ───────────────────────────────────────────────────────────────────

const ORG = "org-1";
const CO = "co-1";
const CONN = {
  company_id: CO,
  organization_id: ORG,
  provider: "quickbooks",
  status: "active",
  remote_tenant_id: "realm-1",
  remote_name: "A1",
  environment: "production",
  settings: ST,
  sync_start_date: "2026-10-01",
  connected_by: null,
  connected_at: "2026-10-01T00:00:00Z",
  last_sync_at: null,
  last_error: null,
};

function job(entity_type: string, entity_id: string, extra: Record<string, unknown> = {}) {
  return { id: `job-${entity_type}-${entity_id}`, organization_id: ORG, company_id: CO, entity_type, entity_id, status: "running", attempts: 1, max_attempts: 6, available_at: "", locked_at: "", last_error: null, detail: null, done_at: null, ...extra };
}

function setup(extra: Record<string, Array<Record<string, unknown>>> = {}) {
  db = createFakeDb({
    accounting_connections: [{ ...CONN }],
    accounting_links: [],
    accounting_sync_jobs: [],
    companies: [{ id: CO, organization_id: ORG, timezone: "America/Toronto" }],
    invoices: [{ ...INV, organization_id: ORG, company_id: CO, booking_id: null, quote_id: null }],
    invoice_payments: [],
    expenses: [],
    bookings: [],
    quotes: [],
    ...extra,
  });
  const enqueued: Array<[string, string]> = [];
  (db.client as unknown as { rpc: unknown }).rpc = vi.fn(async (fn: string, args: Record<string, string>) => {
    if (fn === "enqueue_accounting_sync") enqueued.push([args.p_entity_type, args.p_entity_id]);
    if (fn === "claim_accounting_sync_jobs") {
      const due = db.tables.accounting_sync_jobs.filter((j) => j.status === "pending");
      due.forEach((j) => {
        j.status = "running";
        j.attempts = (j.attempts as number) + 1;
      });
      return { data: due, error: null };
    }
    return { data: null, error: null };
  });
  return { enqueued, ctx: new engine.SyncContext(db.client as never, { ...CONN } as never, "America/Toronto", fetch) };
}

beforeEach(() => {
  calls.length = 0;
  failNext = null;
  seq = 0;
  receipts.clear();
});

describe("sync engine", () => {
  it("creates the customer then the invoice, and makes no call when nothing changed", async () => {
    const { ctx } = setup();
    expect(await engine.syncInvoice(ctx, INV.id)).toMatchObject({ status: "done", detail: "Created INV-0007." });
    expect(calls.map((c) => c.fn)).toEqual(["customer", "pushInvoice"]);
    expect(db.tables.accounting_links.map((l) => [l.entity_type, l.local_key])).toEqual([
      ["customer", "contact:c1"],
      ["invoice", INV.id],
    ]);
    calls.length = 0;
    expect(await engine.syncInvoice(ctx, INV.id)).toMatchObject({ status: "done", detail: "Up to date (INV-0007)." });
    expect(calls).toEqual([]);
    // A real change goes over as an update to the same record.
    db.tables.invoices[0].due_date = "2026-10-26";
    await engine.syncInvoice(ctx, INV.id);
    expect(calls.map((c) => [c.fn, c.args.at(-1)])).toEqual([["pushInvoice", "inv-2"]]);
  });

  it("skips drafts, old invoices and turned-off sync; voids only what was synced", async () => {
    const { ctx } = setup();
    db.tables.invoices[0].issue_date = "2026-09-15";
    expect((await engine.syncInvoice(ctx, INV.id)).detail).toMatch(/before the sync start date/);
    db.tables.invoices[0].status = "void";
    db.tables.invoices[0].issue_date = "2026-10-05";
    expect((await engine.syncInvoice(ctx, INV.id)).detail).toBe("Voided before it was synced.");
    db.tables.invoices[0].status = "draft";
    expect((await engine.syncInvoice(ctx, INV.id)).detail).toBe("Drafts aren't synced.");
    db.tables.invoices[0].status = "sent";
    await engine.syncInvoice(ctx, INV.id);
    db.tables.invoices[0].status = "void";
    calls.length = 0;
    expect(await engine.syncInvoice(ctx, INV.id)).toMatchObject({ status: "done", detail: "Voided INV-0007." });
    expect(calls.map((c) => c.fn)).toEqual(["voidInvoice"]);
    const off = new engine.SyncContext(db.client as never, { ...CONN, settings: { ...ST, syncInvoices: false } } as never, "UTC", fetch);
    expect((await engine.syncInvoice(off, INV.id)).detail).toBe("Invoice sync is turned off.");
  });

  it("a quote deposit becomes a payment; an online-booking deposit a line", async () => {
    const { ctx } = setup({
      quotes: [{ id: "q1", organization_id: ORG, deposit_paid_at: "2026-09-30T15:00:00Z" }],
    });
    Object.assign(db.tables.invoices[0], { credit_cents: 5000, quote_id: "q1" });
    await engine.syncInvoice(ctx, INV.id);
    expect(calls.map((c) => c.fn)).toEqual(["customer", "pushInvoice", "pushPayment"]);
    expect(calls[2].args.slice(0, 2)).toEqual([`deposit:${INV.id}`, 5000]);
    expect((calls[1].args[0] as { totalCents: number }).totalCents).toBe(56500);

    const two = setup({
      bookings: [{ id: "b1", organization_id: ORG, deposit_invoice_id: "dep-inv" }],
    });
    db.tables.invoices.push({ id: "dep-inv", organization_id: ORG, company_id: CO, invoice_number: "INV-0003" });
    Object.assign(db.tables.invoices[0], { credit_cents: 5000, booking_id: "b1" });
    calls.length = 0;
    await engine.syncInvoice(two.ctx, INV.id);
    expect(calls.map((c) => c.fn)).toEqual(["customer", "pushInvoice"]);
    const doc = calls[1].args[0] as { totalCents: number; lines: Array<{ description: string }> };
    expect(doc.totalCents).toBe(51500);
    expect(doc.lines.at(-1)!.description).toBe("Deposit received (invoice INV-0003)");
  });

  it("a payment pushes its invoice first, and a refund removes it from the file", async () => {
    const { ctx } = setup({
      invoice_payments: [{ id: "p1", organization_id: ORG, company_id: CO, invoice_id: INV.id, amount_cents: 20000, method: "card", status: "succeeded", reference: null, received_at: "2026-10-05T16:00:00Z" }],
    });
    expect(await engine.syncPayment(ctx, "p1")).toMatchObject({ status: "done", detail: "Recorded $200.00 on INV-0007." });
    expect(calls.map((c) => c.fn)).toEqual(["customer", "pushInvoice", "pushPayment"]);
    calls.length = 0;
    expect((await engine.syncPayment(ctx, "p1")).detail).toBe("Up to date.");
    db.tables.invoice_payments[0].status = "refunded";
    expect(await engine.syncPayment(ctx, "p1")).toMatchObject({ status: "done", detail: "Refunded — removed from the file." });
    expect(calls.map((c) => c.fn)).toEqual(["deletePayment"]);
    expect(db.tables.accounting_links.some((l) => l.entity_type === "payment")).toBe(false);
  });

  it("queues payments that were waiting on their invoice", async () => {
    const { ctx, enqueued } = setup({
      invoice_payments: [{ id: "p1", organization_id: ORG, company_id: CO, invoice_id: INV.id, amount_cents: 100, method: "cash", status: "succeeded", received_at: "2026-10-05T16:00:00Z" }],
    });
    await engine.syncInvoice(ctx, INV.id);
    expect(enqueued).toEqual([["payment", "p1"]]);
  });

  it("expenses: vendor, push, receipt once; moved or deleted → removed from the file", async () => {
    const e = { id: "e1", organization_id: ORG, company_id: CO, spent_on: "2026-10-03", vendor: "Esso", description: null, category: "fuel", amount_cents: 11300, tax_cents: 1300, paid_with: "business", receipt_path: "org-1/r.jpg", receipt_type: "image/jpeg" };
    const { ctx } = setup({ expenses: [e] });
    receipts.set("org-1/r.jpg", { bytes: Buffer.from("x"), type: "image/jpeg" });
    expect(await engine.syncExpense(ctx, "e1")).toMatchObject({ status: "done", detail: "Created $113.00 at Esso. Receipt attached." });
    expect(calls.map((c) => c.fn)).toEqual(["vendor", "pushExpense", "attachReceipt"]);
    expect(calls[2].args.slice(1)).toEqual(["receipt-2026-10-03.jpg", "image/jpeg"]);
    calls.length = 0;
    expect((await engine.syncExpense(ctx, "e1")).detail).toBe("Up to date.");
    expect(calls).toEqual([]);
    db.tables.expenses[0].amount_cents = 12000;
    await engine.syncExpense(ctx, "e1");
    expect(calls.map((c) => c.fn)).toEqual(["pushExpense"]); // vendor cached, receipt already there
    db.tables.expenses[0].company_id = "other-co";
    calls.length = 0;
    expect(await engine.syncExpense(ctx, "e1")).toMatchObject({ detail: "Deleted from the file." });
    expect(calls.map((c) => c.fn)).toEqual(["deleteExpense"]);
  });

  it("a receipt that can't be attached is noted, not fatal", async () => {
    const { ctx } = setup({ expenses: [{ id: "e1", organization_id: ORG, company_id: CO, spent_on: "2026-10-03", vendor: null, description: "Tape", category: "materials", amount_cents: 500, tax_cents: 0, paid_with: "business", receipt_path: "org-1/gone.jpg" }] });
    const out = await engine.syncExpense(ctx, "e1");
    expect(out.status).toBe("done");
    expect(out.detail).toMatch(/Receipt not attached \(missing\)/);
    expect(db.tables.accounting_links.find((l) => l.entity_type === "expense")!.note).toBe("Receipt not attached: missing");
    expect(calls.map((c) => c.fn)).toEqual(["pushExpense"]); // QuickBooks: no vendor needed
  });

  it("the pass: done / needs-setup fails / outage backs off / dead sign-in pauses the company", async () => {
    setup({
      expenses: [{ id: "e1", organization_id: ORG, company_id: CO, spent_on: "2026-10-03", vendor: null, description: "Tape", category: "materials", amount_cents: 500, tax_cents: 0, paid_with: "business" }],
    });
    db.tables.accounting_sync_jobs.push({ ...job("invoice", INV.id), status: "pending", attempts: 0 }, { ...job("expense", "e1"), status: "pending", attempts: 0 });
    expect(await engine.processAccountingJobs({ admin: db.client as never })).toEqual({ claimed: 2, done: 2, skipped: 0, retrying: 0, failed: 0 });
    expect(db.tables.accounting_connections[0].last_sync_at).toBeTruthy();

    // Unmapped settings → fails straight away with a message saying what to choose.
    db.tables.accounting_connections[0].settings = { ...ST, incomeTarget: null };
    db.tables.invoices[0].due_date = "2026-11-01";
    db.tables.accounting_sync_jobs.push({ ...job("invoice", INV.id), id: "j2", status: "pending", attempts: 0 });
    expect((await engine.processAccountingJobs({ admin: db.client as never })).failed).toBe(1);
    expect(db.tables.accounting_sync_jobs.find((j) => j.id === "j2")!.last_error).toMatch(/Finish the account mapping .*Product\/service for invoice lines/);

    // Outage → back off, honouring Retry-After.
    db.tables.accounting_connections[0].settings = ST;
    db.tables.accounting_sync_jobs.push({ ...job("invoice", INV.id), id: "j3", status: "pending", attempts: 0 });
    failNext = new ProviderError("down", { retryable: true, retryAfterSeconds: 900 });
    const before = Date.now();
    expect((await engine.processAccountingJobs({ admin: db.client as never })).retrying).toBe(1);
    const j3 = db.tables.accounting_sync_jobs.find((j) => j.id === "j3")!;
    expect(j3.status).toBe("pending");
    expect(Date.parse(j3.available_at as string) - before).toBeGreaterThanOrEqual(899_000);

    // Dead sign-in → company paused, connection flagged, attempt not counted.
    j3.available_at = new Date(0).toISOString();
    failNext = new ProviderError("expired", { reauth: true });
    expect((await engine.processAccountingJobs({ admin: db.client as never })).retrying).toBe(1);
    expect(db.tables.accounting_connections[0].status).toBe("needs_reauth");
    expect(db.tables.accounting_sync_jobs.find((j) => j.id === "j3")!.attempts).toBe(1);
  });

  it("backs off exponentially, capped at six hours", () => {
    expect(engine.backoffSeconds(1)).toBe(60);
    expect(engine.backoffSeconds(3)).toBe(240);
    expect(engine.backoffSeconds(20)).toBe(6 * 3600);
    expect(engine.backoffSeconds(1, 120)).toBe(120);
  });
});
