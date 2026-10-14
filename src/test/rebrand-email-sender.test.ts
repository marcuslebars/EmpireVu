/**
 * D7 (Everdoer rebrand): the per-company From address.
 *
 *   companies.email_from_address → EVERDOER_DEFAULT_FROM_EMAIL → OUTBOUND_FROM_EMAIL → LEAD_FROM_EMAIL
 *
 * The contract that matters most: with no company value and EVERDOER_DEFAULT_FROM_EMAIL
 * unset, every message goes out exactly as before (same From header, same request body).
 * And a company pinned to its own sender (A1) keeps it even when the platform default is
 * set, including when its row can't be read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadCompanyFromAddress, resetCompanySenderCache, resolveFromAddress, companyFromAddressOf } from "@/server/outbound/company-sender";
import { readEmailConfig, sendEmail } from "@/server/outbound/email";

const A1_FROM = "quotes@a1marinestorage.ca";
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue({ ok: true, json: () => Promise.resolve({ id: "re_1" }) });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("OUTBOUND_FROM_EMAIL", A1_FROM);
  vi.stubEnv("LEAD_FROM_EMAIL", "");
  vi.stubEnv("EVERDOER_DEFAULT_FROM_EMAIL", "");
  resetCompanySenderCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function sentBody(): Record<string, unknown> {
  return JSON.parse(fetchMock.mock.calls[0][1].body as string) as Record<string, unknown>;
}

describe("resolveFromAddress: three-level fallback", () => {
  it("company value first, then EVERDOER_DEFAULT_FROM_EMAIL, then OUTBOUND_FROM_EMAIL, then LEAD_FROM_EMAIL", () => {
    const env = {
      EVERDOER_DEFAULT_FROM_EMAIL: "hello@everdoer.com",
      OUTBOUND_FROM_EMAIL: A1_FROM,
      LEAD_FROM_EMAIL: "leads@a1marinecare.ca",
    } as NodeJS.ProcessEnv;
    expect(resolveFromAddress("quotes@a1marinecare.ca", env)).toBe("quotes@a1marinecare.ca");
    expect(resolveFromAddress(null, env)).toBe("hello@everdoer.com");
    expect(resolveFromAddress(null, { ...env, EVERDOER_DEFAULT_FROM_EMAIL: undefined })).toBe(A1_FROM);
    expect(resolveFromAddress(null, { LEAD_FROM_EMAIL: "leads@a1marinecare.ca" } as NodeJS.ProcessEnv)).toBe("leads@a1marinecare.ca");
    expect(resolveFromAddress(null, {} as NodeJS.ProcessEnv)).toBeNull();
  });

  it("a blank variable falls back instead of defeating the fallback", () => {
    expect(resolveFromAddress("", { EVERDOER_DEFAULT_FROM_EMAIL: "   ", OUTBOUND_FROM_EMAIL: A1_FROM } as NodeJS.ProcessEnv)).toBe(A1_FROM);
  });

  it("ignores a company value that isn't one plain address (no header injection, no display-name games)", () => {
    const env = { OUTBOUND_FROM_EMAIL: A1_FROM } as NodeJS.ProcessEnv;
    for (const bad of ["not-an-email", "Evil <x@y.com>", "a@b.com\r\nBcc: z@q.com", "a@b", " "]) {
      expect(resolveFromAddress(bad, env)).toBe(A1_FROM);
    }
  });

  it("with nothing new set it is exactly the old OUTBOUND_FROM_EMAIL || LEAD_FROM_EMAIL", () => {
    for (const env of [
      { OUTBOUND_FROM_EMAIL: "A1 Marine Care <hello@a1marinecare.ca>" },
      { OUTBOUND_FROM_EMAIL: "", LEAD_FROM_EMAIL: "leads@a1marinecare.ca" },
      { OUTBOUND_FROM_EMAIL: A1_FROM, LEAD_FROM_EMAIL: "leads@a1marinecare.ca" },
    ] as NodeJS.ProcessEnv[]) {
      expect(resolveFromAddress(null, env)).toBe(env.OUTBOUND_FROM_EMAIL || env.LEAD_FROM_EMAIL);
    }
  });
});

describe("sendEmail From header", () => {
  it("no company value + no EVERDOER_DEFAULT_FROM_EMAIL: identical to before (address and display name)", async () => {
    await sendEmail({ to: "jane@example.com", subject: "Your quote", body: "Hi", fromName: "A1 Marine Storage", replyTo: "office@a1marinestorage.ca" });
    const body = sentBody();
    expect(body.from).toBe(`"A1 Marine Storage" <${A1_FROM}>`);
    expect(body.reply_to).toBe("office@a1marinestorage.ca");
    expect(Object.keys(body).sort()).toEqual(["from", "reply_to", "subject", "text", "to"]);
    expect(readEmailConfig()?.from).toBe(A1_FROM);
  });

  it("a company's own sender wins over the platform default; Reply-To is untouched", async () => {
    vi.stubEnv("EVERDOER_DEFAULT_FROM_EMAIL", "hello@everdoer.com");
    await sendEmail({ to: "jane@example.com", subject: "s", body: "b", fromName: "A1 Marine Storage", replyTo: "office@a1marinestorage.ca", fromAddress: A1_FROM });
    expect(sentBody().from).toBe(`"A1 Marine Storage" <${A1_FROM}>`);
    expect(sentBody().reply_to).toBe("office@a1marinestorage.ca");
  });

  it("platform mail (no company value) uses EVERDOER_DEFAULT_FROM_EMAIL once set, else OUTBOUND_FROM_EMAIL", async () => {
    await sendEmail({ to: "owner@biz.test", subject: "s", body: "b", fromName: "Everdoer" });
    expect(sentBody().from).toBe(`"Everdoer" <${A1_FROM}>`);
    fetchMock.mockClear();
    vi.stubEnv("EVERDOER_DEFAULT_FROM_EMAIL", "hello@everdoer.com");
    await sendEmail({ to: "owner@biz.test", subject: "s", body: "b", fromName: "Everdoer" });
    expect(sentBody().from).toBe('"Everdoer" <hello@everdoer.com>');
  });

  it("a company without a sender (null) gets the platform default", async () => {
    vi.stubEnv("EVERDOER_DEFAULT_FROM_EMAIL", "hello@everdoer.com");
    await sendEmail({ to: "jane@example.com", subject: "s", body: "b", fromName: "Bob's Roofing", fromAddress: null });
    expect(sentBody().from).toBe('"Bob\'s Roofing" <hello@everdoer.com>');
  });

  it("is configured with only EVERDOER_DEFAULT_FROM_EMAIL set", () => {
    vi.stubEnv("OUTBOUND_FROM_EMAIL", "");
    vi.stubEnv("EVERDOER_DEFAULT_FROM_EMAIL", "hello@everdoer.com");
    expect(readEmailConfig()?.from).toBe("hello@everdoer.com");
  });
});

/** A fake client whose companies read answers with `row` (or an error), counting queries. */
function fakeDb(answer: { row?: Record<string, unknown> | null; error?: { message: string } }) {
  const calls: string[] = [];
  const db = {
    from(table: string) {
      calls.push(table);
      const api = {
        select: (cols: string) => {
          calls.push(`select:${cols}`);
          return api;
        },
        eq: () => api,
        maybeSingle: () => Promise.resolve({ data: answer.error ? null : answer.row ?? null, error: answer.error ?? null }),
      };
      return api;
    },
  };
  return { db: db as never, calls };
}

describe("loadCompanyFromAddress", () => {
  it("reads only email_from_address, and caches per company", async () => {
    const { db, calls } = fakeDb({ row: { email_from_address: A1_FROM } });
    expect(await loadCompanyFromAddress(db, "co-a1", 1_000)).toBe(A1_FROM);
    expect(await loadCompanyFromAddress(db, "co-a1", 2_000)).toBe(A1_FROM);
    expect(calls).toEqual(["companies", "select:email_from_address"]);
    // …and reads again once the cache entry is old.
    await loadCompanyFromAddress(db, "co-a1", 1_000 + 6 * 60_000);
    expect(calls.filter((c) => c === "companies")).toHaveLength(2);
  });

  it("null when the company has none or no company is given", async () => {
    const { db, calls } = fakeDb({ row: { email_from_address: null } });
    expect(await loadCompanyFromAddress(db, "co-x")).toBeNull();
    expect(await loadCompanyFromAddress(db, null)).toBeNull();
    expect(calls.filter((c) => c === "companies")).toHaveLength(1);
  });

  it("a failed read (e.g. migration not applied yet) sends from today's address, never the new default", async () => {
    vi.stubEnv("OUTBOUND_FROM_EMAIL", `A1 Marine Storage <${A1_FROM}>`);
    vi.stubEnv("EVERDOER_DEFAULT_FROM_EMAIL", "hello@everdoer.com");
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { db } = fakeDb({ error: { message: 'column companies.email_from_address does not exist' } });
    const got = await loadCompanyFromAddress(db, "co-a1");
    expect(got).toBe(A1_FROM);
    expect(resolveFromAddress(got)).toBe(A1_FROM);
    err.mockRestore();
  });

  it("companyFromAddressOf reads a `*` row, tolerating a row from before the migration", () => {
    expect(companyFromAddressOf({ id: "c", email_from_address: ` ${A1_FROM} ` })).toBe(A1_FROM);
    expect(companyFromAddressOf({ id: "c" })).toBeNull();
    expect(companyFromAddressOf(null)).toBeNull();
  });
});
