/**
 * Xero (Accounting API 2.0, granular scopes).
 *
 *   customers/vendors → Contacts      invoices → Invoices (ACCREC, AUTHORISED)
 *   payments → Payments               expenses → BankTransactions (SPEND) + Attachments
 *
 * Lines are tax-exclusive with our own per-line TaxAmount, so Xero's totals match ours to
 * the cent. Xero payments can't be edited, so a changed payment is deleted and re-created.
 */
import { xeroConfig } from "../config";
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
  const b = (body ?? {}) as { Message?: string; Detail?: string; Elements?: Array<{ ValidationErrors?: Array<{ Message?: string }> }>; Title?: string };
  const validation = b.Elements?.flatMap((e) => e.ValidationErrors ?? []).map((v) => v.Message).filter(Boolean);
  if (validation?.length) return `Xero: ${validation.join(" ").slice(0, 400)}`;
  if (status === 401) return "Xero refused the sign-in — reconnect it in Settings → Accounting.";
  if (status === 403) return "Xero says this connection isn't allowed to do that — reconnect it so it gets the right permissions.";
  if (status === 429) return "Xero's rate limit was hit; retrying shortly.";
  return `Xero: ${(b.Detail || b.Message || b.Title || text || `error ${status}`).slice(0, 300)}`;
}

function api(s: ProviderSession, path: string, init: { method?: string; json?: unknown; body?: BodyInit; headers?: Record<string, string> } = {}): Promise<Obj> {
  return http(
    s.fetch,
    {
      url: `${xeroConfig().apiBase}/${path}`,
      method: init.method,
      json: init.json,
      body: init.body,
      headers: { Authorization: `Bearer ${s.accessToken}`, "xero-tenant-id": s.tenantId, ...init.headers },
    },
    describe,
  ) as Promise<Obj>;
}

const first = (body: Obj, key: string): Obj => {
  const list = body[key] as Obj[] | undefined;
  const row = list?.[0];
  if (!row) throw new ProviderError("Xero didn't return the saved record.");
  return row;
};

const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const isUuid = (v: string) => /^[0-9a-f-]{36}$/i.test(v);

async function findContact(s: ProviderSession, name: string): Promise<Obj[]> {
  const body = await api(s, `Contacts?where=${encodeURIComponent(`Name=="${esc(name)}"`)}&includeArchived=true`);
  return (body.Contacts as Obj[] | undefined) ?? [];
}

async function findOrCreateContact(s: ProviderSession, names: string[], extra: Obj, taken: Set<string>): Promise<RemoteRef> {
  for (const name of names) {
    const found = await findContact(s, name);
    const hit = found.find((c) => typeof c.ContactID === "string" && !taken.has(c.ContactID as string));
    if (hit) return { id: hit.ContactID as string, version: null };
    if (found.length) continue;
    try {
      const body = await api(s, "Contacts", { method: "POST", json: { Contacts: [{ Name: name, ...extra }] } });
      return { id: first(body, "Contacts").ContactID as string, version: null };
    } catch (err) {
      if (err instanceof ProviderError && err.opts.status === 400 && /already assigned/i.test(err.message)) continue;
      throw err;
    }
  }
  throw new ProviderError(`Xero already has a different contact named "${names[0]}" — rename one of them.`);
}

const QTY_DECIMALS = 1e4;

function line(description: string, quantity: number, unitCents: number, amountCents: number, account: Ref | null | undefined, tax: Ref | null | undefined, taxCents: number): Obj {
  const q = Math.round(quantity * QTY_DECIMALS) / QTY_DECIMALS;
  const exact = q !== 0 && Math.abs(q * unitCents - amountCents) < 1e-6;
  return {
    Description: description.slice(0, 4000),
    Quantity: exact ? q : 1,
    UnitAmount: exact ? dollars(unitCents) : dollars(amountCents),
    AccountCode: account?.id,
    TaxType: tax?.id,
    TaxAmount: dollars(taxCents),
  };
}

/** Pick the organisation this sign-in was for (the access token names the auth event). */
export function pickTenant(connections: Obj[], accessToken: string): Obj | null {
  const orgs = connections.filter((c) => c.tenantType === "ORGANISATION" || c.tenantType === undefined);
  let eventId: string | null = null;
  try {
    const claims = JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString("utf8")) as Obj;
    eventId = typeof claims.authentication_event_id === "string" ? claims.authentication_event_id : null;
  } catch {
    eventId = null;
  }
  const matched = eventId ? orgs.filter((c) => c.authEventId === eventId) : [];
  const pool = matched.length ? matched : orgs;
  return [...pool].sort((a, b) => String(b.createdDateUtc ?? "").localeCompare(String(a.createdDateUtc ?? "")))[0] ?? null;
}

export const xero: AccountingProvider = {
  id: "xero",

  authorizeUrl(state, redirectUri) {
    const cfg = xeroConfig();
    const u = new URL(cfg.authorizeUrl);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", cfg.clientId);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("scope", cfg.scopes);
    u.searchParams.set("state", state);
    return u.toString();
  },

  async exchangeCode({ code, redirectUri }, f = fetch) {
    const cfg = xeroConfig();
    const tokens = tokenSetFrom(
      await tokenRequest(f, cfg.tokenUrl, basicAuth(cfg.clientId, cfg.clientSecret), { grant_type: "authorization_code", code, redirect_uri: redirectUri }),
    );
    const conns = (await http(f, { url: cfg.connectionsUrl, headers: { Authorization: `Bearer ${tokens.accessToken}` } }, describe)) as Obj[];
    const tenant = pickTenant(Array.isArray(conns) ? conns : [], tokens.accessToken);
    if (!tenant || typeof tenant.tenantId !== "string") throw new ProviderError("No Xero organisation was connected — choose one on Xero's screen and try again.");
    const session: ProviderSession = { tenantId: tenant.tenantId, accessToken: tokens.accessToken, environment: "production", fetch: f };
    let country: string | null = null;
    let currency: string | null = null;
    try {
      const org = first(await api(session, "Organisation"), "Organisations");
      country = (org.CountryCode as string) ?? null;
      currency = (org.BaseCurrency as string) ?? null;
    } catch {
      // optional
    }
    return { tokens, file: { tenantId: tenant.tenantId, name: (tenant.tenantName as string) ?? null, country, currency } };
  },

  async refresh(refreshToken, f = fetch) {
    const cfg = xeroConfig();
    return tokenSetFrom(await tokenRequest(f, cfg.tokenUrl, basicAuth(cfg.clientId, cfg.clientSecret), { grant_type: "refresh_token", refresh_token: refreshToken }));
  },

  async revoke({ refreshToken }, f = fetch) {
    const cfg = xeroConfig();
    await http(
      f,
      {
        url: cfg.revokeUrl,
        method: "POST",
        headers: { Authorization: basicAuth(cfg.clientId, cfg.clientSecret), "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: refreshToken }).toString(),
      },
      describe,
    );
  },

  async options(s): Promise<ProviderOptions> {
    const [accountsBody, ratesBody] = await Promise.all([api(s, "Accounts"), api(s, "TaxRates")]);
    const accounts = ((accountsBody.Accounts as Obj[] | undefined) ?? []).filter((a) => a.Status === "ACTIVE" || a.Status === undefined);
    const rates = ((ratesBody.TaxRates as Obj[] | undefined) ?? []).filter((r) => r.Status === "ACTIVE" || r.Status === undefined);
    const byName = (a: Ref, b: Ref) => a.name.localeCompare(b.name);
    const coded = (a: Obj): Ref => ({ id: String(a.Code), name: `${a.Code} · ${a.Name}`, kind: (a.Type as string) ?? null });
    const bank = (a: Obj): Ref => ({ id: String(a.AccountID), name: String(a.Name), kind: (a.BankAccountType as string) ?? (a.Type as string) ?? null });
    const rate = (r: Obj): Ref => ({ id: String(r.TaxType), name: String(r.Name) });
    return {
      incomeTargets: accounts.filter((a) => a.Code && (a.Class === "REVENUE" || a.Type === "REVENUE" || a.Type === "SALES")).map(coded).sort(byName),
      salesTaxCodes: rates.filter((r) => r.CanApplyToRevenue !== false).map(rate).sort(byName),
      purchaseTaxCodes: rates.filter((r) => r.CanApplyToExpenses !== false).map(rate).sort(byName),
      depositAccounts: accounts.filter((a) => a.Type === "BANK" || a.EnablePaymentsToAccount === true).map(bank).sort(byName),
      paidFromAccounts: accounts.filter((a) => a.Type === "BANK").map(bank).sort(byName),
      expenseAccounts: accounts.filter((a) => a.Code && (a.Class === "EXPENSE" || ["EXPENSE", "DIRECTCOSTS", "OVERHEADS"].includes(String(a.Type)))).map(coded).sort(byName),
    };
  },

  async findOrCreateCustomer(s, c, taken) {
    const extra: Obj = {
      ...(c.email ? { EmailAddress: c.email } : {}),
      ...(c.phone ? { Phones: [{ PhoneType: "DEFAULT", PhoneNumber: c.phone }] } : {}),
      ...(c.address ? { Addresses: [{ AddressType: "POBOX", AddressLine1: c.address.slice(0, 500) }] } : {}),
    };
    return findOrCreateContact(s, [c.name, c.alternateName], extra, taken);
  },

  async findOrCreateVendor(s, name) {
    // Xero contacts are both customers and suppliers, so the same name is the same contact.
    return findOrCreateContact(s, [name], {}, new Set());
  },

  async pushInvoice(s, doc, customer, st, existing) {
    const invoice: Obj = {
      ...(existing && isUuid(existing.id) ? { InvoiceID: existing.id } : {}),
      Type: "ACCREC",
      Contact: { ContactID: customer.id },
      ...(doc.number ? { InvoiceNumber: doc.number.slice(0, 255) } : {}),
      ...(doc.title ? { Reference: doc.title.slice(0, 255) } : {}),
      Date: doc.issueDate,
      DueDate: doc.dueDate,
      LineAmountTypes: "Exclusive",
      Status: "AUTHORISED",
      LineItems: doc.lines.map((l) =>
        line(l.description, l.quantity, l.unitPriceCents, l.amountCents, st.incomeTarget, l.taxable ? st.salesTaxCode : st.salesExemptCode, l.taxCents),
      ),
    };
    const saved = first(await api(s, "Invoices", { method: "POST", json: { Invoices: [invoice] } }), "Invoices");
    return { id: saved.InvoiceID as string, version: null, totalCents: toCents(saved.Total) };
  },

  async voidInvoice(s, existing) {
    try {
      await api(s, `Invoices/${encodeURIComponent(existing.id)}`, { method: "POST", json: { Invoices: [{ InvoiceID: existing.id, Status: "VOIDED" }] } });
    } catch (err) {
      if (err instanceof ProviderError && /already.*void|VOIDED/i.test(err.message)) return;
      throw err;
    }
  },

  async pushPayment(s, doc, invoice, _customer, st, existing) {
    if (existing) await xero.deletePayment(s, existing);
    const body = await api(s, "Payments", {
      method: "PUT",
      json: {
        Payments: [
          {
            Invoice: { InvoiceID: invoice.id },
            Account: { AccountID: st.paymentAccount?.id },
            Date: doc.date,
            Amount: dollars(doc.amountCents),
            Reference: (doc.reference ? `${doc.memo} · ${doc.reference}` : doc.memo).slice(0, 255),
          },
        ],
      },
    });
    const saved = first(body, "Payments");
    return { id: saved.PaymentID as string, version: null, totalCents: toCents(saved.Amount) };
  },

  async deletePayment(s, existing) {
    try {
      await api(s, `Payments/${encodeURIComponent(existing.id)}`, { method: "POST", json: { Status: "DELETED" } });
    } catch (err) {
      if (err instanceof ProviderError && (err.opts.status === 404 || /already.*deleted/i.test(err.message))) return;
      throw err;
    }
  },

  async pushExpense(s, doc, vendor, st, existing) {
    const from = (doc.personal ? st.paidFromPersonal : null) ?? st.paidFromBusiness;
    const account = st.expenseAccounts[doc.category as keyof AccountingSettings["expenseAccounts"]] ?? st.expenseFallbackAccount;
    if (!vendor) throw new ProviderError("Xero needs a contact on every expense.");
    const tx: Obj = {
      ...(existing && isUuid(existing.id) ? { BankTransactionID: existing.id } : {}),
      Type: "SPEND",
      Contact: { ContactID: vendor.id },
      BankAccount: { AccountID: from?.id },
      Date: doc.date,
      Reference: `${doc.description}`.slice(0, 255),
      LineAmountTypes: "Exclusive",
      LineItems: [line(doc.description, 1, doc.netCents, doc.netCents, account, doc.taxCents > 0 ? st.purchaseTaxCode : st.purchaseExemptCode, doc.taxCents)],
    };
    const saved = first(await api(s, "BankTransactions", { method: "POST", json: { BankTransactions: [tx] } }), "BankTransactions");
    return { id: saved.BankTransactionID as string, version: null, totalCents: toCents(saved.Total) };
  },

  async deleteExpense(s, existing) {
    try {
      await api(s, `BankTransactions/${encodeURIComponent(existing.id)}`, {
        method: "POST",
        json: { BankTransactions: [{ BankTransactionID: existing.id, Status: "DELETED" }] },
      });
    } catch (err) {
      if (err instanceof ProviderError && (err.opts.status === 404 || /already.*deleted/i.test(err.message))) return;
      throw err;
    }
  },

  async attachReceipt(s, expense, file) {
    await api(s, `BankTransactions/${encodeURIComponent(expense.id)}/Attachments/${encodeURIComponent(file.fileName)}`, {
      method: "PUT",
      body: new Uint8Array(file.bytes),
      headers: { "Content-Type": file.contentType },
    });
  },
};
