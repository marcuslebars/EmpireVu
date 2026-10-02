import { describe, expect, it, vi } from "vitest";

import type { TenantServiceContext } from "@/server/services/shared";
import type { WorkflowAction, WorkflowEventContext } from "@/server/services/workflow-engine/types";
import {
  assertPaidActionAllowed,
  PaidActionGuardError,
  unauthenticatedSource,
} from "@/server/services/workflow-engine/guards";

// A chainable, awaitable Supabase stand-in: every builder method returns the chain;
// `.maybeSingle()` and awaiting the chain both resolve to { data, error } for the table.
function fakeSupabase(tables: Record<string, unknown>) {
  const from = vi.fn((table: string) => {
    const result = Promise.resolve({ data: tables[table] ?? null, error: null });
    const chain: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") return (onF: unknown, onR: unknown) => result.then(onF as never, onR as never);
          if (prop === "maybeSingle" || prop === "single") return () => result;
          return () => chain;
        },
      },
    );
    return chain;
  });
  return { from } as unknown as TenantServiceContext["supabase"] & { from: typeof from };
}

// The guard now checks the usage cap first (Task 6). An internal org has an unlimited
// allowance (orgUsageRemaining → null), so the cap is skipped and the abuse checks below
// behave as before unless a test overrides `organizations`.
const INTERNAL_ORG = { plan: "internal", subscription_status: "active", trial_ends_at: null };

function context(tables: Record<string, unknown>): TenantServiceContext {
  return {
    actorProfileId: null,
    organizationId: "org-1",
    supabase: fakeSupabase({ organizations: INTERNAL_ORG, ...tables }),
  } as unknown as TenantServiceContext;
}

const CALL_LEAD = { type: "call_lead" } as WorkflowAction;

function unauthEvent(source = "public_booking"): WorkflowEventContext {
  return {
    activityEvent: { actor_user_id: null },
    metadata: { source },
    companyId: "co-1",
  } as unknown as WorkflowEventContext;
}

function authEvent(): WorkflowEventContext {
  return {
    activityEvent: { actor_user_id: "user-1" },
    metadata: { source: "public_booking" },
    companyId: "co-1",
  } as unknown as WorkflowEventContext;
}

describe("unauthenticatedSource", () => {
  it("returns the source for an actor-less public event", () => {
    expect(unauthenticatedSource(unauthEvent("public_booking"))).toBe("public_booking");
  });
  it("returns null when there is an acting user (authenticated)", () => {
    expect(unauthenticatedSource(authEvent())).toBeNull();
  });
  it("returns null for a trusted/unknown source (e.g. signed intake)", () => {
    expect(unauthenticatedSource(unauthEvent("intake"))).toBeNull();
  });
});

describe("assertPaidActionAllowed", () => {
  it("passes an authenticated trigger with headroom (no cooldown/cap refusal)", async () => {
    const ctx = context({});
    await expect(assertPaidActionAllowed(ctx, authEvent(), CALL_LEAD, "contact-1")).resolves.toBeUndefined();
  });

  it("refuses when the Front Desk monthly voice-minutes cap is spent (guard:usage_cap)", async () => {
    const ctx = context({
      organizations: { plan: "front_desk", subscription_status: "active", trial_ends_at: null },
      subscriptions: null,
      feature_flags: null,
      usage_monthly_v: [{ kind: "voice_minutes", quantity: 500, cost_cents: 0, company_id: null }],
    });
    // Applies regardless of source — an authenticated trigger is still capped.
    await expect(assertPaidActionAllowed(ctx, authEvent(), CALL_LEAD, "contact-1")).rejects.toThrowError(
      "guard:usage_cap",
    );
  });

  it("refuses a second call to the same phone within 24h (guard:cooldown)", async () => {
    const ctx = context({
      contacts: { phone: "+17055550188", company_id: "co-1" },
      // A prior placed call to the same number (different formatting → same last-10).
      activity_events: [{ metadata_json: { toNumber: "+1 (705) 555-0188" } }],
      feature_flags: null,
    });
    await expect(assertPaidActionAllowed(ctx, unauthEvent(), CALL_LEAD, "contact-1")).rejects.toThrowError(
      "guard:cooldown",
    );
  });

  it("allows the call once no matching call remains in the window", async () => {
    const ctx = context({
      contacts: { phone: "+17055550188", company_id: "co-1" },
      activity_events: [], // the earlier call has aged out of the 24h window
      feature_flags: null,
    });
    await expect(assertPaidActionAllowed(ctx, unauthEvent(), CALL_LEAD, "contact-1")).resolves.toBeUndefined();
  });

  it("refuses once the company hits its daily cap of unauthenticated calls", async () => {
    const ctx = context({
      contacts: { phone: "+15145550000", company_id: "co-1" },
      // Two prior unauthenticated-sourced calls to OTHER numbers (no cooldown match).
      activity_events: [
        { metadata_json: { toNumber: "+19995551234", triggerSource: "public_booking" } },
        { metadata_json: { toNumber: "+18885554321", triggerSource: "waitlist" } },
      ],
      feature_flags: { limit_value: 2 }, // cap lowered to 2 for the test
    });
    await expect(assertPaidActionAllowed(ctx, unauthEvent(), CALL_LEAD, "contact-1")).rejects.toThrowError(
      "guard:daily_cap",
    );
  });

  it("allows when under the daily cap", async () => {
    const ctx = context({
      contacts: { phone: "+15145550000", company_id: "co-1" },
      activity_events: [{ metadata_json: { toNumber: "+19995551234", triggerSource: "public_booking" } }],
      feature_flags: null, // default cap of 20
    });
    await expect(assertPaidActionAllowed(ctx, unauthEvent(), CALL_LEAD, "contact-1")).resolves.toBeUndefined();
  });

  it("throws the typed guard error (so the processor records a clean failure_reason)", async () => {
    const ctx = context({
      contacts: { phone: "+17055550188", company_id: "co-1" },
      activity_events: [{ metadata_json: { toNumber: "+17055550188" } }],
      feature_flags: null,
    });
    await assertPaidActionAllowed(ctx, unauthEvent(), CALL_LEAD, "contact-1").catch((err) => {
      expect(err).toBeInstanceOf(PaidActionGuardError);
      expect((err as PaidActionGuardError).reason).toBe("guard:cooldown");
    });
  });
});

// ── SMS leg for unauthenticated sources (public_form / public_booking) ─────────
const SEND_SMS = { type: "send_sms", to: "contact", body: "Thanks!" } as WorkflowAction;
const recent = () => new Date(Date.now() - 60 * 60 * 1000).toISOString();

describe("assertPaidActionAllowed — send_sms from unauthenticated sources", () => {
  it("refuses a second SMS to the same phone inside the cooldown (counted from message_log)", async () => {
    const ctx = context({
      contacts: { phone: "+17055550188", company_id: "co-1" },
      message_log: [{ to_addr: "(705) 555-0188", created_at: recent() }],
    });
    await expect(assertPaidActionAllowed(ctx, unauthEvent("public_form"), SEND_SMS, "contact-1")).rejects.toThrowError(
      "guard:sms_cooldown",
    );
  });

  it("refuses once the company's 24h SMS cap is reached (env-configurable)", async () => {
    process.env.UNAUTH_SMS_DAILY_CAP = "2";
    try {
      const ctx = context({
        contacts: { phone: "+15145550000", company_id: "co-1" },
        message_log: [
          { to_addr: "+19995551234", created_at: recent() },
          { to_addr: "+18885554321", created_at: recent() },
        ],
      });
      await expect(assertPaidActionAllowed(ctx, unauthEvent("public_booking"), SEND_SMS, "contact-1")).rejects.toThrowError(
        "guard:sms_daily_cap",
      );
    } finally {
      delete process.env.UNAUTH_SMS_DAILY_CAP;
    }
  });

  it("allows an SMS under the cap to a number not texted recently", async () => {
    const ctx = context({
      contacts: { phone: "+15145550000", company_id: "co-1" },
      message_log: [{ to_addr: "+19995551234", created_at: recent() }],
    });
    await expect(assertPaidActionAllowed(ctx, unauthEvent("public_form"), SEND_SMS, "contact-1")).resolves.toBeUndefined();
  });

  it("an owner/literal recipient (no contact) is not throttled", async () => {
    const ctx = context({ message_log: [{ to_addr: "+17055550188", created_at: recent() }] });
    await expect(assertPaidActionAllowed(ctx, unauthEvent("public_form"), SEND_SMS, null)).resolves.toBeUndefined();
  });

  it("authenticated triggers are never SMS-throttled", async () => {
    const ctx = context({
      contacts: { phone: "+17055550188", company_id: "co-1" },
      message_log: [{ to_addr: "+17055550188", created_at: recent() }],
    });
    await expect(assertPaidActionAllowed(ctx, authEvent(), SEND_SMS, "contact-1")).resolves.toBeUndefined();
  });

  it("a public-form trigger whose bot check didn't verify gets no paid actions (guard:unverified)", async () => {
    const event = unauthEvent("public_form");
    event.metadata = { source: "public_form", paidActionsVerified: false };
    const ctx = context({ contacts: { phone: "+15145550000", company_id: "co-1" }, message_log: [] });
    await expect(assertPaidActionAllowed(ctx, event, SEND_SMS, "contact-1")).rejects.toThrowError("guard:unverified");
    await expect(assertPaidActionAllowed(ctx, event, CALL_LEAD, "contact-1")).rejects.toThrowError("guard:unverified");
  });
});
