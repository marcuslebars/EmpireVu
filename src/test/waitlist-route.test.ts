/**
 * Public waitlist endpoint — the cross-origin marketing form's collector.
 * Proves: valid signup inserts (lower-cased, idempotent) and echoes an allowed
 * Origin; an unknown Origin is not echoed; a bad email is 400 with no write; the
 * honeypot is a silent no-op; a DB failure is 500; OPTIONS answers the preflight.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const insert = vi.fn();
const order = vi.fn();
const notifyNewWaitlistSignup = vi.fn();

vi.mock("@/server/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({
    from: () => ({
      insert: (...a: unknown[]) => insert(...a),
      select: () => ({ order: (...a: unknown[]) => order(...a) }),
    }),
  }),
}));
vi.mock("@/server/services/waitlist/notify", () => ({
  notifyNewWaitlistSignup: (...a: unknown[]) => notifyNewWaitlistSignup(...a),
}));

import { GET, OPTIONS, POST } from "@/app/api/waitlist/route";

const req = (body: unknown, origin: string | null = "https://empirevu.com") =>
  new Request("https://app.empirevu.com/api/waitlist", {
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      ...(origin ? { origin } : {}),
    },
    method: "POST",
  });

beforeEach(() => {
  insert.mockReset();
  insert.mockResolvedValue({ error: null });
  notifyNewWaitlistSignup.mockReset();
  notifyNewWaitlistSignup.mockResolvedValue(undefined);
  delete process.env.WAITLIST_ALLOWED_ORIGINS;
  delete process.env.WAITLIST_ADMIN_TOKEN;
});
afterEach(() => {
  delete process.env.WAITLIST_ALLOWED_ORIGINS;
  delete process.env.WAITLIST_ADMIN_TOKEN;
});

describe("POST /api/waitlist", () => {
  it("stores a valid signup, lower-cased, echoes the allowed origin, and notifies", async () => {
    const res = await POST(req({ email: "  Sam@Harbour.CA ", business: "Harbour Detailing" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://empirevu.com");
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls[0][0]).toMatchObject({
      business: "Harbour Detailing",
      email: "sam@harbour.ca",
      source: "empirevu.com",
    });
    // a genuinely new signup pings the operator
    expect(notifyNewWaitlistSignup).toHaveBeenCalledTimes(1);
    expect(notifyNewWaitlistSignup.mock.calls[0][0]).toMatchObject({ email: "sam@harbour.ca" });
  });

  it("stores business as null when omitted", async () => {
    await POST(req({ email: "a@b.com" }));
    expect(insert.mock.calls[0][0].business).toBeNull();
  });

  it("treats a duplicate email as an idempotent no-op without re-notifying", async () => {
    insert.mockResolvedValue({ error: { code: "23505", message: "duplicate key" } });
    const res = await POST(req({ email: "again@b.com" }));
    expect(res.status).toBe(200);
    expect(notifyNewWaitlistSignup).not.toHaveBeenCalled();
  });

  it("rejects an invalid email with 400 and writes nothing", async () => {
    const res = await POST(req({ email: "not-an-email" }));
    expect(res.status).toBe(400);
    expect(insert).not.toHaveBeenCalled();
    expect(notifyNewWaitlistSignup).not.toHaveBeenCalled();
  });

  it("silently accepts but drops a honeypot submission", async () => {
    const res = await POST(req({ email: "bot@spam.com", company_url: "http://spam" }));
    expect(res.status).toBe(200);
    expect(insert).not.toHaveBeenCalled();
    expect(notifyNewWaitlistSignup).not.toHaveBeenCalled();
  });

  it("does not echo an origin that isn't allow-listed", async () => {
    const res = await POST(req({ email: "a@b.com" }, "https://evil.example"));
    expect(res.status).toBe(200); // still processes; browser there just can't read it
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("honors WAITLIST_ALLOWED_ORIGINS overrides (e.g. for local dev)", async () => {
    process.env.WAITLIST_ALLOWED_ORIGINS = "http://localhost:3000";
    const res = await POST(req({ email: "a@b.com" }, "http://localhost:3000"));
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
  });

  it("returns 500 when the insert fails with a non-duplicate error", async () => {
    insert.mockResolvedValue({ error: { message: "db down" } });
    const res = await POST(req({ email: "a@b.com" }));
    expect(res.status).toBe(500);
  });
});

describe("OPTIONS /api/waitlist (preflight)", () => {
  it("answers 204 with CORS for an allowed origin", async () => {
    const res = await OPTIONS(req({}, "https://empirevu.com"));
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://empirevu.com");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });
});

describe("GET /api/waitlist (admin read)", () => {
  const adminReq = (token?: string, url = "https://app.empirevu.com/api/waitlist") =>
    new Request(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });

  beforeEach(() => {
    order.mockReset();
    order.mockResolvedValue({
      data: [{ business: "B Co", created_at: "2026-08-31T00:00:00Z", email: "a@b.com", source: "empirevu.com" }],
      error: null,
    });
  });

  it("503 when the admin token isn't configured", async () => {
    const res = await GET(adminReq("whatever"));
    expect(res.status).toBe(503);
    expect(order).not.toHaveBeenCalled();
  });

  it("401 without a token or with the wrong token — and never reads", async () => {
    process.env.WAITLIST_ADMIN_TOKEN = "s3cret";
    expect((await GET(adminReq())).status).toBe(401);
    expect((await GET(adminReq("nope"))).status).toBe(401);
    expect(order).not.toHaveBeenCalled();
  });

  it("200 with the right token → count + signups", async () => {
    process.env.WAITLIST_ADMIN_TOKEN = "s3cret";
    const res = await GET(adminReq("s3cret"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.count).toBe(1);
    expect(body.data.signups[0].email).toBe("a@b.com");
  });

  it("exports CSV with ?format=csv", async () => {
    process.env.WAITLIST_ADMIN_TOKEN = "s3cret";
    const res = await GET(adminReq("s3cret", "https://app.empirevu.com/api/waitlist?format=csv"));
    expect(res.headers.get("content-type")).toContain("text/csv");
    const text = await res.text();
    expect(text.split("\n")[0]).toBe("email,business,source,created_at");
    expect(text).toContain("a@b.com");
  });
});
