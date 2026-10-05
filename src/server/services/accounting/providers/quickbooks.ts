/**
 * QuickBooks Online (Accounting API v3, minorversion ≥ 75).
 *
 *   customers → Customer      invoices → Invoice (SalesItemLineDetail, one product/service)
 *   payments  → Payment       expenses → Purchase (AccountBasedExpenseLineDetail) + Attachable
 *
 * Outside the US, lines carry a TaxCodeRef and GlobalTaxCalculation = TaxExcluded (QuickBooks
 * computes the tax; a rounding difference from ours is noted, not forced). US files use
 * TAX/NON codes and QuickBooks' own sales tax. Updates are sparse and fetch a fresh
 * SyncToken first, so an accountant's edit to another field isn't wiped.
 */
import { quickBooksConfig } from "../config";
import { basicAuth, http, tokenRequest, tokenSetFrom } from "../http";
import { dollars, toCents } from "../mapping";
import {
  ProviderError,
  type AccountingProvider,
  type AccountingSettings,
  type ProviderOptions,
  type ProviderSession,
  type Ref,
  type RemoteRef,
} from "../types";

type Obj = Record<string, unknown>;

function describe(status: number, body: unknown, text: string): string {
  const fault = (body as { Fault?: { Error?: Array<{ Message?: string; Detail?: string; code?: string }> } } | null)?.Fault;
  const e = fault?.Error?.[0];
  if (e) return `QuickBooks: ${(e.Detail || e.Message || "error").slice(0, 400)}${e.code ? ` [${e.code}]` : ""}`;
  if (status === 401) return "QuickBooks refused the sign-in — reconnect it in Settings → Accounting.";
  return `QuickBooks returned ${status}${text ? `: ${text.slice(0, 200)}` : ""}`;
}

const errCode = (err: unknown): string | null => (err instanceof ProviderError ? (/\[(\d+)\]$/.exec(err.message)?.[1] ?? null) : null);

function apiBase(environment: "sandbox" | "production"): string {
  const cfg = quickBooksConfig();
  if (process.env.QUICKBOOKS_API_BASE?.trim()) return cfg.apiBase;
  return environment === "sandbox" ? "https://sandbox-quickbooks.api.intuit.com" : "https://quickbooks.api.intuit.com";
}

function url(s: ProviderSession, path: string, params: Record<string, string> = {}): string {
  const u = new URL(`${apiBase(s.environment)}/v3/company/${encodeURIComponent(s.tenantId)}/${path}`);
  u.searchParams.set("minorversion", quickBooksConfig().minorVersion);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

async function call(s: ProviderSession, path: string, init: { json?: unknown; params?: Record<string, string>; body?: BodyInit } = {}): Promise<Obj> {
  return (await http(
    s.fetch,
    { url: url(s, path, init.params), json: init.json, body: init.body, headers: { Authorization: `Bearer ${s.accessToken}` } },
    describe,
  )) as Obj;
}

const q = (v: string) => v.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

async function query<T = Obj>(s: ProviderSession, entity: string, sql: string): Promise<T[]> {
  const body = await call(s, "query", { params: { query: sql } });
  const resp = (body.QueryResponse ?? {}) as Obj;
  return (resp[entity] as T[] | undefined) ?? [];
}

const ref = (r: Ref | null | undefined) => (r ? { value: r.id, name: r.name } : undefined);

function remote(entity: Obj | undefined): RemoteRef & { totalCents: number | null } {
  if (!entity || typeof entity.Id !== "string") throw new ProviderError("QuickBooks didn't return the saved record.");
  return { id: entity.Id, version: typeof entity.SyncToken === "string" ? entity.SyncToken : null, totalCents: toCents(entity.TotalAmt) };
}

/** Fresh SyncToken; null when the record is gone from the file. */
async function current(s: ProviderSession, entity: string, id: string): Promise<string | null> {
  try {
    const body = await call(s, `${entity.toLowerCase()}/${encodeURIComponent(id)}`);
    const row = body[entity] as Obj | undefined;
    if (!row || row.status === "Deleted") return null;
    return typeof row.SyncToken === "string" ? row.SyncToken : "0";
  } catch (err) {
    if (err instanceof ProviderError && (err.opts.status === 404 || errCode(err) === "610")) return null;
    throw err;
  }
}

async function upsert(s: ProviderSession, entity: string, payload: Obj, existing: RemoteRef | null): Promise<Obj> {
  if (existing) {
    const token = await current(s, entity, existing.id);
    if (token !== null) {
      const body = await call(s, entity.toLowerCase(), { json: { ...payload, Id: existing.id, SyncToken: token, sparse: true } });
      return body[entity] as Obj;
    }
    // Deleted in QuickBooks: create it again rather than fail forever.
  }
  const body = await call(s, entity.toLowerCase(), { json: payload });
  return body[entity] as Obj;
}

async function removeEntity(s: ProviderSession, entity: string, existing: RemoteRef, operation: "delete" | "void"): Promise<void> {
  const token = await current(s, entity, existing.id);
  if (token === null) return; // already gone
  try {
    await call(s, entity.toLowerCase(), { params: { operation }, json: { Id: existing.id, SyncToken: token } });
  } catch (err) {
    // Voiding an already-void invoice is fine.
    if (operation === "void" && err instanceof ProviderError && /void/i.test(err.message) && /already/i.test(err.message)) return;
    throw err;
  }
}

async function findOrCreateNamed(s: ProviderSession, entity: "Customer" | "Vendor", names: string[], extra: Obj, taken: Set<string>): Promise<RemoteRef> {
  for (const name of names) {
    const found = await query<Obj>(s, entity, `select Id, SyncToken, DisplayName from ${entity} where DisplayName = '${q(name)}'`);
    const hit = found.find((r) => typeof r.Id === "string" && !taken.has(r.Id as string));
    if (hit) return { id: hit.Id as string, version: (hit.SyncToken as string) ?? null };
    if (found.length) continue; // that name belongs to a different EmpireVu customer; try the next
    try {
      const body = await call(s, entity.toLowerCase(), { json: { DisplayName: name, ...extra } });
      const r = remote(body[entity] as Obj);
      return { id: r.id, version: r.version };
    } catch (err) {
      // 6240: the name is taken by another kind of record (vendor/employee) — try the next name.
      if (errCode(err) === "6240") continue;
      throw err;
    }
  }
  throw new ProviderError(`QuickBooks already has a different record named "${names[0]}" — rename one of them.`);
}

const QTY_DECIMALS = 1e5;

export const quickbooks: AccountingProvider = {
  id: "quickbooks",

  authorizeUrl(state, redirectUri) {
    const cfg = quickBooksConfig();
    const u = new URL(cfg.authorizeUrl);
    u.searchParams.set("client_id", cfg.clientId);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", cfg.scopes);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("state", state);
    return u.toString();
  },

  async exchangeCode({ code, redirectUri, query: params }, f = fetch) {
    const cfg = quickBooksConfig();
    const realmId = params.get("realmId");
    if (!realmId) throw new ProviderError("QuickBooks didn't say which company was connected — try again.");
    const body = await tokenRequest(f, cfg.tokenUrl, basicAuth(cfg.clientId, cfg.clientSecret), {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    });
    const tokens = tokenSetFrom(body);
    const session: ProviderSession = { tenantId: realmId, accessToken: tokens.accessToken, environment: cfg.environment, fetch: f };
    let name: string | null = null;
    let country: string | null = null;
    let currency: string | null = null;
    try {
      const info = (await call(session, `companyinfo/${encodeURIComponent(realmId)}`)).CompanyInfo as Obj | undefined;
      name = (info?.CompanyName as string) ?? null;
      country = (info?.Country as string) ?? null;
      const prefs = (await call(session, "preferences")).Preferences as Obj | undefined;
      const cur = ((prefs?.CurrencyPrefs as Obj | undefined)?.HomeCurrency as Obj | undefined)?.value;
      currency = typeof cur === "string" ? cur : null;
    } catch {
      // Name/country are nice-to-have; the connection still works.
    }
    return { tokens, file: { tenantId: realmId, name, country, currency } };
  },

  async refresh(refreshToken, f = fetch) {
    const cfg = quickBooksConfig();
    return tokenSetFrom(await tokenRequest(f, cfg.tokenUrl, basicAuth(cfg.clientId, cfg.clientSecret), { grant_type: "refresh_token", refresh_token: refreshToken }));
  },

  async revoke({ refreshToken }, f = fetch) {
    const cfg = quickBooksConfig();
    await http(
      f,
      { url: cfg.revokeUrl, method: "POST", json: { token: refreshToken }, headers: { Authorization: basicAuth(cfg.clientId, cfg.clientSecret) } },
      describe,
    );
  },

  async options(s): Promise<ProviderOptions> {
    const [items, codes, accounts] = await Promise.all([
      query<Obj>(s, "Item", "select * from Item where Active = true maxresults 1000"),
      query<Obj>(s, "TaxCode", "select * from TaxCode where Active = true maxresults 1000"),
      query<Obj>(s, "Account", "select * from Account where Active = true maxresults 1000"),
    ]);
    const r = (o: Obj, name = o.FullyQualifiedName ?? o.Name): Ref => ({ id: String(o.Id), name: String(name ?? o.Id), kind: (o.AccountType as string) ?? null });
    const hasRates = (o: Obj, key: string) => (((o[key] as Obj | undefined)?.TaxRateDetail as unknown[] | undefined)?.length ?? 0) > 0;
    const anyRates = codes.some((c) => hasRates(c, "SalesTaxRateList") || hasRates(c, "PurchaseTaxRateList"));
    const byName = (a: Ref, b: Ref) => a.name.localeCompare(b.name);
    return {
      incomeTargets: items.filter((i) => i.Type === "Service" || i.Type === "NonInventory").map((i) => r(i)).sort(byName),
      salesTaxCodes: codes.filter((c) => !anyRates || hasRates(c, "SalesTaxRateList")).map((c) => ({ id: String(c.Id), name: String(c.Name) })).sort(byName),
      purchaseTaxCodes: codes.filter((c) => !anyRates || hasRates(c, "PurchaseTaxRateList")).map((c) => ({ id: String(c.Id), name: String(c.Name) })).sort(byName),
      depositAccounts: accounts.filter((a) => a.AccountType === "Bank" || a.AccountSubType === "UndepositedFunds").map((a) => r(a)).sort(byName),
      paidFromAccounts: accounts.filter((a) => a.AccountType === "Bank" || a.AccountType === "Credit Card").map((a) => r(a)).sort(byName),
      expenseAccounts: accounts
        .filter((a) => a.AccountType === "Expense" || a.AccountType === "Other Expense" || a.AccountType === "Cost of Goods Sold")
        .map((a) => r(a))
        .sort(byName),
    };
  },

  async findOrCreateCustomer(s, c, taken) {
    const extra: Obj = {
      ...(c.email ? { PrimaryEmailAddr: { Address: c.email } } : {}),
      ...(c.phone ? { PrimaryPhone: { FreeFormNumber: c.phone } } : {}),
      ...(c.address ? { BillAddr: { Line1: c.address.slice(0, 500) } } : {}),
    };
    return findOrCreateNamed(s, "Customer", [c.name, c.alternateName, `${c.name} (customer)`.slice(0, 100)], extra, taken);
  },

  async findOrCreateVendor(s, name) {
    try {
      return await findOrCreateNamed(s, "Vendor", [name, `${name} (vendor)`.slice(0, 100)], {}, new Set());
    } catch (err) {
      // A vendor is optional on a QuickBooks expense — book it without one rather than fail.
      if (err instanceof ProviderError && !err.retryable && !err.reauth) return null;
      throw err;
    }
  },

  async pushInvoice(s, doc, customer, st, existing) {
    const us = st.country === "US";
    const Line = doc.lines.map((l) => {
      const exactQty = Math.round(l.quantity * QTY_DECIMALS) / QTY_DECIMALS;
      // Only when qty × price lands on whole cents with no rounding (QuickBooks checks it).
      const exact = exactQty !== 0 && Math.abs(exactQty * l.unitPriceCents - l.amountCents) < 1e-6;
      return {
        DetailType: "SalesItemLineDetail",
        Amount: dollars(l.amountCents),
        Description: l.description.slice(0, 4000),
        SalesItemLineDetail: {
          ItemRef: ref(st.incomeTarget),
          Qty: exact ? exactQty : 1,
          UnitPrice: exact ? dollars(l.unitPriceCents) : dollars(l.amountCents),
          TaxCodeRef: us ? { value: l.taxable ? "TAX" : "NON" } : ref(l.taxable ? st.salesTaxCode : st.salesExemptCode),
        },
      };
    });
    const payload: Obj = {
      CustomerRef: { value: customer.id },
      ...(doc.number ? { DocNumber: doc.number.slice(0, 21) } : {}),
      TxnDate: doc.issueDate,
      DueDate: doc.dueDate,
      Line,
      PrivateNote: doc.memo.slice(0, 4000),
      ...(us ? {} : { GlobalTaxCalculation: "TaxExcluded" }),
    };
    return remote(await upsert(s, "Invoice", payload, existing));
  },

  async voidInvoice(s, existing) {
    await removeEntity(s, "Invoice", existing, "void");
  },

  async pushPayment(s, doc, invoice, customer, st, existing) {
    const payload: Obj = {
      CustomerRef: { value: customer.id },
      TotalAmt: dollars(doc.amountCents),
      TxnDate: doc.date,
      ...(doc.reference ? { PaymentRefNum: doc.reference.slice(0, 21) } : {}),
      DepositToAccountRef: ref(st.paymentAccount),
      PrivateNote: doc.memo.slice(0, 4000),
      Line: [{ Amount: dollars(doc.amountCents), LinkedTxn: [{ TxnId: invoice.id, TxnType: "Invoice" }] }],
    };
    return remote(await upsert(s, "Payment", payload, existing));
  },

  async deletePayment(s, existing) {
    await removeEntity(s, "Payment", existing, "delete");
  },

  async pushExpense(s, doc, vendor, st, existing) {
    const us = st.country === "US";
    const from = (doc.personal ? st.paidFromPersonal : null) ?? st.paidFromBusiness;
    const account = st.expenseAccounts[doc.category as keyof AccountingSettings["expenseAccounts"]] ?? st.expenseFallbackAccount;
    const payload: Obj = {
      PaymentType: from?.kind === "Credit Card" ? "CreditCard" : "Cash",
      AccountRef: ref(from),
      TxnDate: doc.date,
      ...(vendor ? { EntityRef: { value: vendor.id, type: "Vendor" } } : {}),
      PrivateNote: `${doc.description} · ${doc.memo}`.slice(0, 4000),
      Line: [
        {
          DetailType: "AccountBasedExpenseLineDetail",
          // US files: sales tax paid is part of the cost. Elsewhere: the net, with the tax code.
          Amount: dollars(us ? doc.totalCents : doc.netCents),
          Description: doc.description.slice(0, 4000),
          AccountBasedExpenseLineDetail: {
            AccountRef: ref(account),
            ...(us ? {} : { TaxCodeRef: ref(doc.taxCents > 0 ? st.purchaseTaxCode : st.purchaseExemptCode) }),
          },
        },
      ],
      ...(us ? {} : { GlobalTaxCalculation: "TaxExcluded" }),
    };
    return remote(await upsert(s, "Purchase", payload, existing));
  },

  async deleteExpense(s, existing) {
    await removeEntity(s, "Purchase", existing, "delete");
  },

  async attachReceipt(s, expense, file) {
    const form = new FormData();
    form.append(
      "file_metadata_01",
      new Blob([JSON.stringify({ AttachableRef: [{ EntityRef: { type: "Purchase", value: expense.id } }], FileName: file.fileName, ContentType: file.contentType })], {
        type: "application/json",
      }),
      "attachment.json",
    );
    form.append("file_content_01", new Blob([new Uint8Array(file.bytes)], { type: file.contentType }), file.fileName);
    await call(s, "upload", { body: form });
  },
};
