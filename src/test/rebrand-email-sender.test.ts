/**
 * D7 (Everdoer rebrand): which From a company's email goes out from.
 *
 *   companies.email_from_address → house org (A1): OUTBOUND_FROM_EMAIL verbatim →
 *   EVERDOER_DEFAULT_FROM_EMAIL → OUTBOUND_FROM_EMAIL || LEAD_FROM_EMAIL
 *
 * With no company value and EVERDOER_DEFAULT_FROM_EMAIL unset, every message goes out exactly as
 * before. A1 never moves to @everdoer.com. A failed read never guesses once the new default is set.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CompanySenderUnavailableError,
  isHouseOrgRow,
  loadCompanyFromAddress,
  platformFromAddress,
  resetCompanySenderCache,
  resolveFromAddress,
} from "@/server/outbound/company-sender";
import { readEmailConfig, sendEmail } from "@/server/outbound/email";
import { classifyByRules } from "@/server/services/staff/email-clerk/classify";

const A1_FROM = "A1 Marine Storage <quotes@a1marinestorage.ca>";
const fetchMock = vi.fn();
const env = (e: Record<string, string | undefined>) => e as unknown as NodeJS.ProcessEnv;

beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue({ ok: true, json: () => Promise.resolve({ id: "re_1" }) });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("OUTBOUND_FROM_EMAIL", A1_FROM);
  vi.stubEnv("LEAD_FROM_EMAIL", "");
  vi.stubEnv("EVERDOER_DEFAULT_FROM_EMAIL", "");
  vi.stubEnv("LEAD_INTAKE_ORG_SLUG", "a1-group");
  resetCompanySenderCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function sentFrom(i = 0): unknown {
  return (JSON.parse(fetchMock.mock.calls[i][1].body as string) as Record<string, unknown>).from;
}

describe("resolveFromAddress: the four levels", () => {
  const all = env({ EVERDOER_DEFAULT_FROM_EMAIL: "hello@everdoer.com", OUTBOUND_FROM_EMAIL: A1_FROM, LEAD_FROM_EMAIL: "leads@a1marinecare.ca" });

  it("own address, then the house org's OUTBOUND_FROM_EMAIL verbatim, then the new default, then today's", () => {
    expect(resolveFromAddress({ own: "care@a1marinecare.ca", house: true }, all)).toBe("care@a1marinecare.ca");
    expect(resolveFromAddress({ own: null, house: true }, all)).toBe(A1_FROM);
    expect(resolveFromAddress({ own: null, house: false }, all)).toBe("hello@everdoer.com");
    expect(resolveFromAddress(null, all)).toBe("hello@everdoer.com");
    expect(resolveFromAddress({ own: null, house: false }, env({ OUTBOUND_FROM_EMAIL: A1_FROM }))).toBe(A1_FROM);
    expect(resolveFromAddress(null, env({ LEAD_FROM_EMAIL: "leads@a1marinecare.ca" }))).toBe("leads@a1marinecare.ca");
    expect(resolveFromAddress(null, env({}))).toBeNull();
  });

  it("the house org falls back to LEAD_FROM_EMAIL like today, never to the new default while either is set", () => {
    expect(resolveFromAddress({ own: null, house: true }, env({ EVERDOER_DEFAULT_FROM_EMAIL: "hello@everdoer.com", LEAD_FROM_EMAIL: "leads@a1marinecare.ca" }))).toBe("leads@a1marinecare.ca");
  });

  it("blank variables fall back; a malformed own address is ignored", () => {
    expect(platformFromAddress(env({ EVERDOER_DEFAULT_FROM_EMAIL: "  ", OUTBOUND_FROM_EMAIL: A1_FROM }))).toBe(A1_FROM);
    for (const bad of ["not-an-email", "Evil <x@y.com>", "a@b.com\r\nBcc: z@q.com", "a@b"]) {
      expect(resolveFromAddress({ own: bad, house: false }, env({ OUTBOUND_FROM_EMAIL: "x@y.com" }))).toBe("x@y.com");
    }
  });

  it("house org = plan internal or the LEAD_INTAKE_ORG_SLUG slug (messaging.ts uses the same rule)", () => {
    expect(isHouseOrgRow({ plan: "launch", slug: "a1-group" })).toBe(true);
    expect(isHouseOrgRow({ plan: "internal", slug: "x" })).toBe(true);
    expect(isHouseOrgRow({ plan: "operate", slug: "blairs" })).toBe(false);
    expect(isHouseOrgRow(null)).toBe(false);
  });
});

/** A fake service-role client: companies + organizations, counting reads; `fail` makes reads error. */
function fakeAdmin(rows: { companies: Record<string, Record<string, unknown> | null>; orgs: Record<string, Record<string, unknown>> }, fail?: string) {
  const reads: string[] = [];
  const admin = {
    from(table: string) {
      let id = "";
      const api = {
        select: () => api,
        eq: (_c: string, v: string) => {
          id = v;
          return api;
        },
        maybeSingle: () => {
          reads.push(`${table}:${id}`);
          if (fail) return Promise.resolve({ data: null, error: { message: fail } });
          const data = table === "companies" ? rows.companies[id] ?? null : rows.orgs[id] ?? null;
          return Promise.resolve({ data, error: null });
        },
      };
      return api;
    },
  };
  return { admin: admin as never, reads };
}

const WORLD = {
  companies: {
    "co-a1": { organization_id: "org-a1", email_from_address: null },
    "co-a1-own": { organization_id: "org-a1", email_from_address: "care@a1marinecare.ca" },
    "co-blairs": { organization_id: "org-blairs", email_from_address: null },
    "co-lookalike": { organization_id: "org-blairs", email_from_address: null },
  },
  orgs: { "org-a1": { plan: "internal", slug: "a1-group" }, "org-blairs": { plan: "operate", slug: "blairs" } },
};

describe("loadCompanyFromAddress", () => {
  it("nothing new set: every company sends exactly as before (no fromAddress)", async () => {
    const { admin } = fakeAdmin(WORLD);
    expect(await loadCompanyFromAddress("co-a1", { admin })).toBeNull();
    expect(await loadCompanyFromAddress("co-blairs", { admin })).toBeNull();
    expect(await loadCompanyFromAddress(null, { admin })).toBeNull();
  });

  it("with EVERDOER_DEFAULT_FROM_EMAIL set the house org keeps OUTBOUND_FROM_EMAIL, display name included", async () => {
    vi.stubEnv("EVERDOER_DEFAULT_FROM_EMAIL", "hello@everdoer.com");
    const { admin } = fakeAdmin(WORLD);
    const a1 = await loadCompanyFromAddress("co-a1", { admin });
    expect(a1).toBe(A1_FROM);
    expect(await loadCompanyFromAddress("co-a1-own", { admin })).toBe("care@a1marinecare.ca");
    expect(await loadCompanyFromAddress("co-blairs", { admin })).toBeNull(); // = the platform default

    await sendEmail({ to: "jane@example.com", subject: "s", body: "b", fromAddress: a1 });
    expect(sentFrom(0)).toBe(A1_FROM);
    await sendEmail({ to: "jane@example.com", subject: "s", body: "b", fromName: "Blair's Marine" });
    expect(sentFrom(1)).toBe('"Blair\'s Marine" <hello@everdoer.com>');
  });

  it("caches a successful read; a null (RLS-hidden / missing) read is not cached", async () => {
    const { admin, reads } = fakeAdmin(WORLD);
    await loadCompanyFromAddress("co-a1", { admin, now: 1_000 });
    await loadCompanyFromAddress("co-a1", { admin, now: 2_000 });
    expect(reads).toEqual(["companies:co-a1", "organizations:org-a1"]);

    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const hidden = fakeAdmin({ companies: { "co-hidden": null }, orgs: {} });
    await loadCompanyFromAddress("co-hidden", { admin: hidden.admin, now: 1_000 });
    await loadCompanyFromAddress("co-hidden", { admin: hidden.admin, now: 1_500 });
    expect(hidden.reads).toEqual(["companies:co-hidden", "companies:co-hidden"]);
    err.mockRestore();
  });

  it("read error, EVERDOER_DEFAULT_FROM_EMAIL unset: today's sender (identical behaviour)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { admin } = fakeAdmin(WORLD, "column companies.email_from_address does not exist");
    expect(await loadCompanyFromAddress("co-a1", { admin })).toBeNull();
    expect(readEmailConfig()?.from).toBe(A1_FROM);
    err.mockRestore();
  });

  it("read error, EVERDOER_DEFAULT_FROM_EMAIL set: throws (no guessing), logged at most once a minute", async () => {
    vi.stubEnv("EVERDOER_DEFAULT_FROM_EMAIL", "hello@everdoer.com");
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { admin } = fakeAdmin(WORLD, "db down");
    await expect(loadCompanyFromAddress("co-a1", { admin, now: 0 })).rejects.toBeInstanceOf(CompanySenderUnavailableError);
    await expect(loadCompanyFromAddress("co-a1", { admin, now: 30_000 })).rejects.toBeInstanceOf(CompanySenderUnavailableError);
    expect(err).toHaveBeenCalledTimes(1);
    await expect(loadCompanyFromAddress("co-a1", { admin, now: 61_000 })).rejects.toThrow(/not sending rather than guessing/);
    expect(err).toHaveBeenCalledTimes(2);
    err.mockRestore();
  });
});

describe("sendEmail with no company sender", () => {
  it("is byte-identical to before: same From, same body keys", async () => {
    await sendEmail({ to: "jane@example.com", subject: "Your quote", body: "Hi", fromName: "A1 Marine Storage", replyTo: "office@a1marinestorage.ca" });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as Record<string, unknown>;
    expect(body.from).toBe('"A1 Marine Storage" <quotes@a1marinestorage.ca>');
    expect(Object.keys(body).sort()).toEqual(["from", "reply_to", "subject", "text", "to"]);
  });
});

describe("email inbox loop check (L1)", () => {
  const base = {
    inboxAddress: "inbox@in.everdoer.com",
    inboundDomain: null,
    outboundFrom: null,
    ownerEmail: null,
    forwardedFrom: null,
    suppliers: [],
    purchaseOrders: [],
    knownContact: false,
  };
  const facts = (from: string) => ({ fromAddress: from, fromName: null, subject: "Re: your quote", text: "hello", headers: {}, auth: null });

  it("treats mail from ANY of our senders as our own, bare and case-insensitive", () => {
    const ctx = { ...base, outboundFroms: [A1_FROM, "hello@everdoer.com", null, "Leads <LEADS@a1marinecare.ca>"] };
    for (const from of ["QUOTES@a1marinestorage.ca", "hello@EVERDOER.com", "leads@a1marinecare.ca"]) {
      expect(classifyByRules(facts(from), ctx as never).rule?.category).toBe("no_reply");
    }
    expect(classifyByRules(facts("jane@example.com"), ctx as never).rule?.category).not.toBe("no_reply");
  });
});
