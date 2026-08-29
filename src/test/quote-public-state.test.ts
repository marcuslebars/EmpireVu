import { describe, expect, it } from "vitest";

import { EXPIRABLE_STATUSES } from "@/server/services/quotes/expiry";
import { QUOTE_STATUSES, canTransition } from "@/server/services/quotes/lifecycle";
import { derivePageState, isApprovable } from "@/server/services/quotes/public-service";

const NOW = new Date("2026-09-15T12:00:00Z");
const FUTURE = "2026-10-15T12:00:00Z";
const PAST = "2026-09-01T12:00:00Z";

/** Minimal row shape — derivePageState only reads these fields. */
const row = (over: Record<string, unknown> = {}) => ({
  status: "sent",
  valid_until: FUTURE,
  expires_at: FUTURE,
  superseded_by: null,
  ...over,
});

describe("quote page state — which states offer approval", () => {
  it("a live, in-date quote is active and approvable", () => {
    expect(derivePageState(row({ status: "sent" }), NOW)).toBe("active");
    expect(derivePageState(row({ status: "viewed" }), NOW)).toBe("active");
    expect(isApprovable("active")).toBe(true);
  });

  it("ONLY active is approvable — every other state is read-only", () => {
    for (const s of ["expired", "replaced", "confirmed", "cancelled"] as const) {
      expect(isApprovable(s)).toBe(false);
    }
  });
});

describe("quote page state — expiry", () => {
  it("renders expired once the status has been swept", () => {
    expect(derivePageState(row({ status: "expired" }), NOW)).toBe("expired");
  });

  it("renders expired when past valid_until even before the cron runs", () => {
    // Otherwise a late sweep would let someone approve a stale price.
    expect(derivePageState(row({ status: "sent", valid_until: PAST, expires_at: PAST }), NOW)).toBe(
      "expired",
    );
    expect(derivePageState(row({ status: "viewed", valid_until: PAST, expires_at: PAST }), NOW)).toBe(
      "expired",
    );
  });

  it("treats the valid_until instant itself as expired", () => {
    const at = NOW.toISOString();
    expect(derivePageState(row({ valid_until: at, expires_at: at }), NOW)).toBe("expired");
  });

  it("never expires a quote the customer already committed to", () => {
    // Even with a long-past date, an approved or paid quote stays confirmed.
    for (const status of ["approved", "deposit_paid", "completed"]) {
      expect(derivePageState(row({ status, valid_until: PAST, expires_at: PAST }), NOW)).toBe("confirmed");
    }
  });
});

describe("quote page state — supersession", () => {
  it("renders replaced when superseded, so the customer is sent to the new quote", () => {
    expect(derivePageState(row({ status: "cancelled", superseded_by: "q2" }), NOW)).toBe("replaced");
  });

  it("prefers replaced over expired — pointing forward beats asking for a refresh", () => {
    const r = row({ status: "cancelled", superseded_by: "q2", valid_until: PAST, expires_at: PAST });
    expect(derivePageState(r, NOW)).toBe("replaced");
  });

  it("a superseded quote can never be approved", () => {
    const state = derivePageState(row({ status: "cancelled", superseded_by: "q2" }), NOW);
    expect(isApprovable(state)).toBe(false);
  });

  it("distinguishes a plain cancellation from a replacement", () => {
    // Cancelled with no successor: nothing to point the customer at.
    expect(derivePageState(row({ status: "cancelled" }), NOW)).toBe("cancelled");
    expect(isApprovable("cancelled")).toBe(false);
  });
});

describe("quote page state — every status maps to a state", () => {
  it("covers the full status set with no undefined fallthrough", () => {
    for (const status of QUOTE_STATUSES) {
      const state = derivePageState(row({ status }), NOW);
      expect(["active", "expired", "replaced", "confirmed", "cancelled"]).toContain(state);
    }
  });
});

describe("expiry sweep and the lifecycle table agree", () => {
  it("sweeps exactly the statuses the lifecycle permits expiring from", () => {
    const legal = QUOTE_STATUSES.filter((s) => canTransition(s, "expired"));
    expect([...EXPIRABLE_STATUSES].sort()).toEqual([...legal].sort());
  });

  it("never sweeps a committed quote", () => {
    for (const s of ["approved", "deposit_paid", "completed"] as const) {
      expect(EXPIRABLE_STATUSES).not.toContain(s);
      expect(canTransition(s, "expired")).toBe(false);
    }
  });
});
