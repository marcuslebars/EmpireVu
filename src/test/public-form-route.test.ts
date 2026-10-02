/**
 * Public website form endpoint — POST/GET /api/public/forms/[formKey].
 * Proves: the tenant comes from the KEY (payload org/company/sourceSite ignored); the
 * envelope is a valid schemaVersion-1 lead; revoked/unknown keys, bad origins, honeypot,
 * too-fast, Turnstile, rate limits and oversized bodies are all refused with NO write;
 * a durable-write failure is a 500 (never a false success).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { leadEnvelopeSchema } from "@/server/services/lead-intake/envelope";

const handleLeadIntake = vi.fn();
vi.mock("@/server/services/lead-intake/intake", () => ({
  handleLeadIntake: (...args: unknown[]) => handleLeadIntake(...args),
}));

const resolvePublicFormKey = vi.fn();
const listPublicServiceLabels = vi.fn();
const touchPublicFormKey = vi.fn();
vi.mock("@/server/services/lead-intake/public-forms", async () => {
  const actual = await vi.importActual<typeof import("@/server/services/lead-intake/public-forms")>(
    "@/server/services/lead-intake/public-forms",
  );
  return {
    ...actual,
    resolvePublicFormKey: (...args: unknown[]) => resolvePublicFormKey(...args),
    listPublicServiceLabels: (...args: unknown[]) => listPublicServiceLabels(...args),
    touchPublicFormKey: (...args: unknown[]) => touchPublicFormKey(...args),
  };
});

const enforceRateLimit = vi.fn();
vi.mock("@/server/services/rate-limit", () => ({
  clientIp: () => "203.0.113.9",
  enforceRateLimit: (...args: unknown[]) => enforceRateLimit(...args),
}));

import { GET, OPTIONS, POST } from "@/app/api/public/forms/[formKey]/route";

const KEY = `evpk_${"a".repeat(48)}`;
const APP = "https://app.example.com";

function form(overrides: Record<string, unknown> = {}) {
  return {
    id: "form-1",
    organizationId: "org-K",
    companyId: "co-K",
    formType: "quote",
    allowedOrigins: [],
    company: { name: "Kirk Snow Removal", slug: "kirk-snow", logoUrl: null, phone: "+17055550100", primaryColor: null },
    ...overrides,
  };
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return new Request(`${APP}/api/public/forms/${KEY}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP, host: "app.example.com", ...headers },
    body: raw,
  });
}

const ctx = { params: { formKey: KEY } };

const goodBody = {
  name: "Pat Plow",
  phone: "705-555-0199",
  email: "Pat@Example.com",
  service: "Driveway clearing",
  message: "Long driveway, need seasonal contract",
  preferredDate: "2026-11-15",
  smsConsent: true,
  page: "https://kirksnow.ca/services?utm_source=google",
  utm: { utm_source: "google", utm_campaign: "fall", evil: "x" },
  formStartedAt: Date.now() - 20_000,
};

beforeEach(() => {
  handleLeadIntake.mockReset().mockResolvedValue({ ok: true, leadId: "lead_abc" });
  resolvePublicFormKey.mockReset().mockResolvedValue(form());
  listPublicServiceLabels.mockReset().mockResolvedValue(["Driveway clearing", "Salting"]);
  touchPublicFormKey.mockReset().mockResolvedValue(undefined);
  enforceRateLimit.mockReset().mockResolvedValue(null);
  delete process.env.TURNSTILE_SECRET_KEY;
  delete process.env.APP_BASE_URL;
});
afterEach(() => {
  delete process.env.TURNSTILE_SECRET_KEY;
});

describe("POST — tenancy pinning + envelope", () => {
  it("pins org/company from the key; payload org/company/sourceSite are ignored", async () => {
    const res = await POST(
      post({ ...goodBody, organizationId: "EVIL-ORG", companyId: "EVIL-CO", sourceSite: "attacker" }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { ok: true, leadId: "lead_abc" } });
    expect(handleLeadIntake).toHaveBeenCalledTimes(1);
    const [rawBody, envelope, options] = handleLeadIntake.mock.calls[0];
    expect(options).toEqual({
      target: { organizationId: "org-K", companyId: "co-K" },
      workflowTrigger: { source: "public_form" },
    });
    expect(JSON.parse(rawBody as string)).toEqual(envelope);
    expect(JSON.stringify(envelope)).not.toContain("EVIL");
    expect((envelope as { sourceSite: string }).sourceSite).toBe("kirk-snow");
  });

  it("builds a valid schemaVersion-1 envelope (formType, meta.site/page/utm, consent)", async () => {
    await POST(post(goodBody), ctx);
    const envelope = handleLeadIntake.mock.calls[0][1];
    const parsed = leadEnvelopeSchema.safeParse(envelope);
    expect(parsed.success).toBe(true);
    const env = parsed.success ? parsed.data : null;
    expect(env?.schemaVersion).toBe(1);
    expect(env?.formType).toBe("quote");
    expect(env?.source).toBe("public_form");
    expect(env?.contact).toEqual({ name: "Pat Plow", email: "pat@example.com", phone: "705-555-0199" });
    expect(env?.services).toEqual(["Driveway clearing"]);
    expect(env?.message).toContain("Service: Driveway clearing");
    expect(env?.message).toContain("Preferred date: 2026-11-15");
    expect(env?.meta?.site).toBe("kirksnow.ca");
    expect(env?.meta?.page).toBe("/services");
    expect(env?.meta?.utm).toEqual({ utm_source: "google", utm_campaign: "fall" });
    expect(env?.meta?.preferredDate).toBe("2026-11-15");
    expect(env?.meta?.smsConsent?.granted).toBe(true);
    expect(env?.meta?.smsConsent?.text).toContain("Reply STOP");
    expect(env?.meta?.smsConsent?.text).toContain("Kirk Snow Removal");
  });

  it("contact form keys record formType 'contact'; unticked consent stays implied", async () => {
    resolvePublicFormKey.mockResolvedValue(form({ formType: "contact", company: { ...form().company, slug: null } }));
    await POST(post({ ...goodBody, smsConsent: false }), ctx);
    const env = handleLeadIntake.mock.calls[0][1] as { formType: string; sourceSite: string; meta: { smsConsent: { granted: boolean; text?: string } } };
    expect(env.formType).toBe("contact");
    expect(env.sourceSite).toBe("embed");
    expect(env.meta.smsConsent.granted).toBe(false);
    expect(env.meta.smsConsent.text).toBeUndefined();
  });

  it("touches last_used_at only AFTER the durable write succeeds", async () => {
    await POST(post(goodBody), ctx);
    expect(handleLeadIntake.mock.invocationCallOrder[0]).toBeLessThan(touchPublicFormKey.mock.invocationCallOrder[0]);
  });

  it("500 when the durable write fails (never a false success)", async () => {
    handleLeadIntake.mockRejectedValue(new Error("db down"));
    const res = await POST(post(goodBody), ctx);
    expect(res.status).toBe(500);
    expect(touchPublicFormKey).not.toHaveBeenCalled();
  });

  it("400 when neither phone nor email is given (no write)", async () => {
    const res = await POST(post({ name: "No Contact", formStartedAt: Date.now() - 20_000 }), ctx);
    expect(res.status).toBe(400);
    expect(handleLeadIntake).not.toHaveBeenCalled();
  });
});

describe("POST — key resolution", () => {
  it("404 for a revoked / unknown key, and no write", async () => {
    resolvePublicFormKey.mockResolvedValue(null);
    const res = await POST(post(goodBody), ctx);
    expect(res.status).toBe(404);
    expect(handleLeadIntake).not.toHaveBeenCalled();
  });
});

describe("POST — origin policy", () => {
  it("cross-origin site on the allowed list → 200 with CORS echo", async () => {
    resolvePublicFormKey.mockResolvedValue(form({ allowedOrigins: ["https://kirksnow.ca"] }));
    const res = await POST(post(goodBody, { origin: "https://kirksnow.ca" }), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://kirksnow.ca");
  });

  it("cross-origin site NOT on the list → 403, no write", async () => {
    resolvePublicFormKey.mockResolvedValue(form({ allowedOrigins: ["https://kirksnow.ca"] }));
    const res = await POST(post(goodBody, { origin: "https://spammer.example" }), ctx);
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(handleLeadIntake).not.toHaveBeenCalled();
  });

  it("empty allowed list → any site may post", async () => {
    const res = await POST(post(goodBody, { origin: "https://anything.example" }), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://anything.example");
  });

  it("the hosted page (app origin) is always allowed, even with a list", async () => {
    resolvePublicFormKey.mockResolvedValue(form({ allowedOrigins: ["https://kirksnow.ca"] }));
    const res = await POST(post(goodBody), ctx);
    expect(res.status).toBe(200);
  });

  it("embedded on a site that isn't on the list → 403", async () => {
    resolvePublicFormKey.mockResolvedValue(form({ allowedOrigins: ["https://kirksnow.ca"] }));
    const res = await POST(post({ ...goodBody, embedOrigin: "https://copycat.example" }), ctx);
    expect(res.status).toBe(403);
    expect(handleLeadIntake).not.toHaveBeenCalled();
  });

  it("embedded on an allowed site → 200", async () => {
    resolvePublicFormKey.mockResolvedValue(form({ allowedOrigins: ["https://kirksnow.ca"] }));
    const res = await POST(post({ ...goodBody, embedOrigin: "https://kirksnow.ca" }), ctx);
    expect(res.status).toBe(200);
  });

  it("no Origin header on a write → 403", async () => {
    const req = new Request(`${APP}/api/public/forms/${KEY}`, {
      method: "POST",
      headers: { "content-type": "application/json", host: "app.example.com" },
      body: JSON.stringify(goodBody),
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(403);
    expect(handleLeadIntake).not.toHaveBeenCalled();
  });
});

describe("POST — abuse layers", () => {
  it("honeypot filled → 400, no write", async () => {
    const res = await POST(post({ ...goodBody, website: "http://spam.example" }), ctx);
    expect(res.status).toBe(400);
    expect(handleLeadIntake).not.toHaveBeenCalled();
  });

  it("submitted faster than a person could → 400, no write", async () => {
    const res = await POST(post({ ...goodBody, formStartedAt: Date.now() - 500 }), ctx);
    expect(res.status).toBe(400);
    expect(handleLeadIntake).not.toHaveBeenCalled();
  });

  it("Turnstile configured + missing token → 400, no write", async () => {
    process.env.TURNSTILE_SECRET_KEY = "secret";
    const res = await POST(post(goodBody), ctx);
    expect(res.status).toBe(400);
    expect(handleLeadIntake).not.toHaveBeenCalled();
  });

  it("per-IP rate limit tripped → 429, key never resolved, no write", async () => {
    const { NextResponse } = await import("next/server");
    enforceRateLimit.mockResolvedValueOnce(NextResponse.json({ error: "Too many" }, { status: 429 }));
    const res = await POST(post(goodBody), ctx);
    expect(res.status).toBe(429);
    expect(resolvePublicFormKey).not.toHaveBeenCalled();
    expect(handleLeadIntake).not.toHaveBeenCalled();
  });

  it("per-form rate limit is keyed on the form id", async () => {
    const { NextResponse } = await import("next/server");
    enforceRateLimit
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(NextResponse.json({ error: "Too many" }, { status: 429 }));
    const res = await POST(post(goodBody), ctx);
    expect(res.status).toBe(429);
    const formLimit = enforceRateLimit.mock.calls[1][1] as { scope: string; keyParts: string[] };
    expect(formLimit.scope).toBe("public_form_post_key");
    expect(formLimit.keyParts).toEqual(["form-1"]);
    expect(handleLeadIntake).not.toHaveBeenCalled();
  });

  it("oversized body → 413, no write", async () => {
    const res = await POST(post({ ...goodBody, message: "x".repeat(20_000) }), ctx);
    expect(res.status).toBe(413);
    expect(handleLeadIntake).not.toHaveBeenCalled();
  });
});

describe("GET + OPTIONS", () => {
  it("returns display-safe config only", async () => {
    const res = await GET(new Request(`${APP}/api/public/forms/${KEY}`, { headers: { host: "app.example.com" } }), ctx);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: Record<string, unknown> };
    expect(Object.keys(json.data).sort()).toEqual(["company", "form", "services"]);
    expect(json.data.company).toEqual({ name: "Kirk Snow Removal", logoUrl: null, phone: "+17055550100", primaryColor: null });
    expect(json.data.services).toEqual(["Driveway clearing", "Salting"]);
    const text = JSON.stringify(json);
    expect(text).not.toContain("org-K");
    expect(text).not.toContain("co-K");
    expect(text).not.toContain("form-1");
  });

  it("404 for a revoked key", async () => {
    resolvePublicFormKey.mockResolvedValue(null);
    const res = await GET(new Request(`${APP}/api/public/forms/${KEY}`), ctx);
    expect(res.status).toBe(404);
  });

  it("preflight echoes only an allowed origin", async () => {
    resolvePublicFormKey.mockResolvedValue(form({ allowedOrigins: ["https://kirksnow.ca"] }));
    const ok = await OPTIONS(new Request(`${APP}/api/public/forms/${KEY}`, { method: "OPTIONS", headers: { origin: "https://kirksnow.ca" } }), ctx);
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://kirksnow.ca");
    const no = await OPTIONS(new Request(`${APP}/api/public/forms/${KEY}`, { method: "OPTIONS", headers: { origin: "https://evil.example" } }), ctx);
    expect(no.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("hosted page route", () => {
  it("/f/:formKey is reachable signed-out (no bounce to /signin)", async () => {
    const { isPublicPath } = await import("@/lib/public-routes");
    expect(isPublicPath(`/f/${KEY}`)).toBe(true);
    expect(isPublicPath("/settings/f/thing")).toBe(false);
  });
});
