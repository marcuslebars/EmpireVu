import { afterEach, describe, expect, it, vi } from "vitest";

import { assessFormSignals, verifyTurnstile } from "@/server/services/turnstile";

const originalSecret = process.env.TURNSTILE_SECRET_KEY;

function req(): Request {
  return new Request("https://api.empirevu.com/x", { headers: { "x-forwarded-for": "203.0.113.9" } });
}

afterEach(() => {
  if (originalSecret === undefined) delete process.env.TURNSTILE_SECRET_KEY;
  else process.env.TURNSTILE_SECRET_KEY = originalSecret;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("assessFormSignals", () => {
  it("rejects a filled honeypot", () => {
    expect(assessFormSignals({ honeypot: "http://spam.example" })).toEqual({ ok: false, reason: "honeypot" });
  });

  it("rejects a submission faster than the minimum fill time", () => {
    const now = 100_000;
    expect(assessFormSignals({ formStartedAt: now - 1000, now, minMillis: 3000 })).toEqual({
      ok: false,
      reason: "too_fast",
    });
  });

  it("allows a normal, unhurried submission", () => {
    const now = 100_000;
    expect(assessFormSignals({ honeypot: "", formStartedAt: now - 10_000, now })).toEqual({ ok: true });
  });

  it("does not reject when the timestamp is missing (can't prove it fast)", () => {
    expect(assessFormSignals({})).toEqual({ ok: true });
  });

  it("ignores clock skew (negative elapsed is not 'too fast')", () => {
    const now = 100_000;
    expect(assessFormSignals({ formStartedAt: now + 5000, now })).toEqual({ ok: true });
  });
});

describe("verifyTurnstile", () => {
  it("SKIPS (fail-open) when the secret is unset", async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    const fetchSpy = vi.stubGlobal("fetch", vi.fn());
    const result = await verifyTurnstile(req(), "any-token");
    expect(result).toEqual({ ok: true, degraded: true });
    expect(fetchSpy).not.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a missing token once the secret is set", async () => {
    process.env.TURNSTILE_SECRET_KEY = "secret";
    const result = await verifyTurnstile(req(), null);
    expect(result).toEqual({ ok: false, reason: "missing_token" });
  });

  it("accepts a token Cloudflare verifies", async () => {
    process.env.TURNSTILE_SECRET_KEY = "secret";
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ json: () => Promise.resolve({ success: true }) })));
    expect(await verifyTurnstile(req(), "good")).toEqual({ ok: true });
  });

  it("rejects a token Cloudflare fails", async () => {
    process.env.TURNSTILE_SECRET_KEY = "secret";
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ json: () => Promise.resolve({ success: false }) })));
    expect(await verifyTurnstile(req(), "bad")).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("fails OPEN when Cloudflare is unreachable", async () => {
    process.env.TURNSTILE_SECRET_KEY = "secret";
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("network"))));
    expect(await verifyTurnstile(req(), "token")).toEqual({ ok: true, degraded: true });
  });
});
