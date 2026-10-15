import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "./helpers/fake-supabase";
import { captureLegacyUsage } from "@/test/helpers/legacy-usage-capture";

// Everdoer rebrand PR 1: /api/public/everdoer/* and /welcome/everdoer aliases; old paths counted.

let db: FakeDb;
vi.mock("@/server/supabase/admin", () => ({ createSupabaseAdminClient: () => db.client }));
vi.mock("@/server/services/rate-limit", () => ({
  clientIp: () => "203.0.113.9",
  trustedClientIp: () => "203.0.113.9",
  enforceRateLimit: async () => null,
}));
vi.mock("@/server/services/billing/stripe", () => ({ getStripeClient: () => ({}) }));
vi.mock("@/server/services/done-for-you/provision", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/services/done-for-you/provision")>()),
  resendWelcomeEmail: async () => "not_found",
}));

import * as oldCheckout from "@/app/api/public/crankleads/checkout/route";
import * as oldStatus from "@/app/api/public/crankleads/checkout/[sessionId]/route";
import * as oldResend from "@/app/api/public/crankleads/checkout/[sessionId]/resend/route";
import * as oldStop from "@/app/api/public/crankleads/setup-reminders/route";
import * as newCheckout from "@/app/api/public/everdoer/checkout/route";
import * as newStatus from "@/app/api/public/everdoer/checkout/[sessionId]/route";
import * as newResend from "@/app/api/public/everdoer/checkout/[sessionId]/resend/route";
import * as newStop from "@/app/api/public/everdoer/setup-reminders/route";
import { purchaseApiPrefix } from "@/lib/done-for-you-purchase-api";
import { isPublicPath } from "@/lib/public-routes";
import { stopRemindersUrl } from "@/server/services/done-for-you/setup-followups";
import { publicDoneForYouApiPrefix } from "@/server/services/rebrand/route-alias";

const SESSION = "cs_test_a1B2c3D4e5F6g7H8i9J0";
const TOKEN = "a".repeat(48);

let capture: ReturnType<typeof captureLegacyUsage>;
beforeEach(() => {
  db = createFakeDb();
  capture = captureLegacyUsage();
  vi.stubEnv("EVERDOER_WRITE_NEW_NAMES", "");
});
afterEach(() => {
  capture.restore();
  vi.unstubAllEnvs();
});

async function routeRows() {
  return (await capture.rows()).filter((r) => r.kind === "route");
}

describe("API aliases re-export the same handlers", () => {
  it("each alias exports exactly the old handlers and force-dynamic", () => {
    expect(newCheckout.POST).toBe(oldCheckout.POST);
    expect(newCheckout.OPTIONS).toBe(oldCheckout.OPTIONS);
    expect(newStatus.GET).toBe(oldStatus.GET);
    expect(newResend.POST).toBe(oldResend.POST);
    expect(newStop.GET).toBe(oldStop.GET);
    expect(newStop.POST).toBe(oldStop.POST);
    for (const mod of [newCheckout, newStatus, newResend, newStop]) expect(mod.dynamic).toBe("force-dynamic");
  });
});

describe("old paths are counted under a stable key, new paths are not", () => {
  const host = "https://app.empirevu.com";

  it("checkout (OPTIONS) on both paths", async () => {
    await oldCheckout.OPTIONS(new Request(`${host}/api/public/crankleads/checkout`, { method: "OPTIONS" }));
    await newCheckout.OPTIONS(new Request(`${host}/api/public/everdoer/checkout`, { method: "OPTIONS" }));
    expect(await routeRows()).toEqual([{ kind: "route", key: "/api/public/crankleads/checkout", sample: null, count: 1 }]);
  });

  it("status poll and resend: the session id never reaches the key or sample", async () => {
    await oldStatus.GET(new Request(`${host}/api/public/crankleads/checkout/${SESSION}`), { params: { sessionId: SESSION } });
    await newStatus.GET(new Request(`${host}/api/public/everdoer/checkout/${SESSION}`), { params: { sessionId: SESSION } });
    await oldResend.POST(new Request(`${host}/api/public/crankleads/checkout/${SESSION}/resend`, { method: "POST" }), {
      params: { sessionId: SESSION },
    });
    await newResend.POST(new Request(`${host}/api/public/everdoer/checkout/${SESSION}/resend`, { method: "POST" }), {
      params: { sessionId: SESSION },
    });
    const rows = await routeRows();
    expect(rows.map((r) => r.key).sort()).toEqual([
      "/api/public/crankleads/checkout/[sessionId]",
      "/api/public/crankleads/checkout/[sessionId]/resend",
    ]);
    expect(JSON.stringify(rows)).not.toContain(SESSION);
  });

  it("setup-reminders: the token never reaches the key or sample; both paths serve the page", async () => {
    const oldRes = await oldStop.GET(new Request(`${host}/api/public/crankleads/setup-reminders?token=${TOKEN}`));
    const newRes = await newStop.GET(new Request(`${host}/api/public/everdoer/setup-reminders?token=${TOKEN}`));
    expect(oldRes.status).toBe(200);
    expect(newRes.status).toBe(200);
    // The confirm form posts back to its own path (relative action), so the alias stays on the alias.
    expect(await newRes.text()).toContain(`action="?token=${TOKEN}"`);
    const rows = await routeRows();
    expect(rows).toEqual([{ kind: "route", key: "/api/public/crankleads/setup-reminders", sample: null, count: 1 }]);
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
  });
});

describe("builders write the old paths until EVERDOER_WRITE_NEW_NAMES", () => {
  it("stop link", () => {
    expect(stopRemindersUrl("https://app.crankleads.com", TOKEN)).toBe(
      `https://app.crankleads.com/api/public/crankleads/setup-reminders?token=${TOKEN}`,
    );
    vi.stubEnv("EVERDOER_WRITE_NEW_NAMES", "1");
    expect(stopRemindersUrl("https://app.crankleads.com", TOKEN)).toBe(
      `https://app.crankleads.com/api/public/everdoer/setup-reminders?token=${TOKEN}`,
    );
  });

  it("prefix helper", () => {
    expect(publicDoneForYouApiPrefix({})).toBe("/api/public/crankleads/");
    expect(publicDoneForYouApiPrefix({ EVERDOER_WRITE_NEW_NAMES: "true" })).toBe("/api/public/everdoer/");
  });

  it("the welcome page calls the API under the same name it was opened on", () => {
    expect(purchaseApiPrefix("/welcome/crankleads")).toBe("/api/public/crankleads");
    expect(purchaseApiPrefix("/welcome/everdoer")).toBe("/api/public/everdoer");
  });
});

describe("SPA /welcome/everdoer", () => {
  it("is public like /welcome/crankleads", () => {
    expect(isPublicPath("/welcome/crankleads")).toBe(true);
    expect(isPublicPath("/welcome/everdoer")).toBe(true);
    expect(isPublicPath("/welcome/everdoer/")).toBe(true);
    expect(isPublicPath("/welcome/everdoer/x")).toBe(false);
  });

  it("routes to the same page as /welcome/crankleads (old route kept)", () => {
    const app = readFileSync(resolve(__dirname, "../App.tsx"), "utf8");
    expect(app).toContain('<Route path="/welcome/crankleads" element={<CrankleadsWelcomePage />} />');
    expect(app).toContain('<Route path="/welcome/everdoer" element={<CrankleadsWelcomePage />} />');
  });
});
