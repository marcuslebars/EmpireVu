import { describe, expect, it } from "vitest";

import {
  QUOTE_STATUSES,
  QuoteTransitionError,
  TERMINAL_STATUSES,
  allowedTransitions,
  assertTransition,
  canTransition,
  evaluateTransition,
  isQuoteStatus,
  type QuoteStatus,
} from "@/server/services/quotes/lifecycle";

describe("quote lifecycle — the status set", () => {
  it("is exactly the set the migration's check constraint allows", () => {
    expect([...QUOTE_STATUSES]).toEqual([
      "draft",
      "sent",
      "viewed",
      "approved",
      "deposit_paid",
      "completed",
      "expired",
      "cancelled",
    ]);
  });

  it("recognises its own members and nothing else", () => {
    for (const s of QUOTE_STATUSES) expect(isQuoteStatus(s)).toBe(true);
    for (const s of ["", "paid", "APPROVED", null, 7, undefined]) expect(isQuoteStatus(s)).toBe(false);
  });
});

describe("quote lifecycle — the happy path", () => {
  const path: QuoteStatus[] = ["draft", "sent", "viewed", "approved", "deposit_paid", "completed"];

  it("walks draft → sent → viewed → approved → deposit_paid → completed", () => {
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i], path[i + 1])).toBe(true);
      expect(() => assertTransition(path[i], path[i + 1])).not.toThrow();
    }
  });

  it("allows approval straight from sent, skipping viewed", () => {
    // The view write is a best-effort beacon; losing it must not block approval.
    expect(canTransition("sent", "approved")).toBe(true);
  });
});

describe("quote lifecycle — the edges that must NOT exist", () => {
  it("never walks backwards", () => {
    expect(canTransition("viewed", "sent")).toBe(false);
    expect(canTransition("approved", "viewed")).toBe(false);
    expect(canTransition("deposit_paid", "approved")).toBe(false);
    expect(canTransition("completed", "deposit_paid")).toBe(false);
  });

  it("cannot expire a quote the customer already committed to", () => {
    // The whole point of the table: a cron must not retract an approved quote.
    expect(canTransition("approved", "expired")).toBe(false);
    expect(canTransition("deposit_paid", "expired")).toBe(false);
    expect(canTransition("completed", "expired")).toBe(false);
  });

  it("cannot take a deposit on a quote that was never approved", () => {
    expect(canTransition("draft", "deposit_paid")).toBe(false);
    expect(canTransition("sent", "deposit_paid")).toBe(false);
    expect(canTransition("viewed", "deposit_paid")).toBe(false);
    expect(canTransition("expired", "deposit_paid")).toBe(false);
    expect(canTransition("cancelled", "deposit_paid")).toBe(false);
  });

  it("cannot complete a quote whose deposit was never paid", () => {
    expect(canTransition("approved", "completed")).toBe(false);
    expect(canTransition("sent", "completed")).toBe(false);
  });

  it("treats completed and cancelled as fully terminal", () => {
    expect(allowedTransitions("completed")).toEqual([]);
    expect(allowedTransitions("cancelled")).toEqual([]);
  });

  it("lets an expired quote only be cancelled, never revived", () => {
    expect(allowedTransitions("expired")).toEqual(["cancelled"]);
  });

  it("throws QuoteTransitionError naming both ends", () => {
    try {
      assertTransition("expired", "deposit_paid");
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(QuoteTransitionError);
      const e = err as QuoteTransitionError;
      expect(e.from).toBe("expired");
      expect(e.to).toBe("deposit_paid");
      expect(e.message).toContain("expired");
      expect(e.message).toContain("deposit_paid");
    }
  });
});

describe("quote lifecycle — cancellation", () => {
  it("is reachable from every non-terminal state", () => {
    for (const s of QUOTE_STATUSES) {
      if (TERMINAL_STATUSES.includes(s)) continue;
      expect(canTransition(s, "cancelled")).toBe(true);
    }
  });

  it("is reachable from expired but not from completed", () => {
    expect(canTransition("expired", "cancelled")).toBe(true);
    expect(canTransition("completed", "cancelled")).toBe(false);
  });
});

describe("quote lifecycle — webhook idempotency", () => {
  it("treats a redelivered same-status event as a no-op, not an error", () => {
    // Stripe redelivers; the second checkout.session.completed must not 500.
    expect(evaluateTransition("deposit_paid", "deposit_paid")).toBe("noop");
    expect(evaluateTransition("completed", "completed")).toBe("noop");
  });

  it("applies a legal move and rejects an illegal one", () => {
    expect(evaluateTransition("approved", "deposit_paid")).toBe("apply");
    expect(evaluateTransition("cancelled", "deposit_paid")).toBe("illegal");
  });
});

describe("quote lifecycle — table integrity", () => {
  it("has an entry for every status and names only real statuses", () => {
    for (const s of QUOTE_STATUSES) {
      const next = allowedTransitions(s);
      expect(Array.isArray(next)).toBe(true);
      for (const t of next) expect(isQuoteStatus(t)).toBe(true);
    }
  });

  it("never lists a self-transition", () => {
    for (const s of QUOTE_STATUSES) expect(allowedTransitions(s)).not.toContain(s);
  });
});
