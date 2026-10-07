import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { z } from "zod";

/**
 * handleRoute is the last thing between a thrown error and a person's screen.
 * Messages written for users (UserFacingError and its subclasses) pass through;
 * anything else — a database error, a Stripe error, a bug — is logged with an
 * error id and the user gets a generic apology plus that id.
 */

import { GENERIC_ERROR_MESSAGE, UserFacingError } from "@/server/errors";
import { handleRoute } from "@/server/api/route";
import { AuthorizationError, TooManyRequestsError, ValidationError } from "@/server/organizations/context";
import { InvoiceConflictError, InvoiceNotFoundError } from "@/server/services/invoices/errors";
import { InvoiceCheckoutError } from "@/server/services/invoices/public";
import { QuoteTransitionError } from "@/server/services/quotes/lifecycle";
import { QuoteTotalChangedError } from "@/server/services/quotes/service";
import { customerSafeMessage } from "@/lib/public-errors";

async function run(err: unknown) {
  const res = await handleRoute(async () => {
    throw err;
  }, "PATCH /api/test");
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, headers: res.headers };
}

let logged: unknown[][] = [];
beforeEach(() => {
  logged = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logged.push(args);
  });
});
afterEach(() => vi.restoreAllMocks());

describe("handleRoute masks errors that weren't written for users", () => {
  it("replaces a raw database error with the generic message and an error id", async () => {
    const { status, body } = await run(new Error('duplicate key value violates unique constraint "quotes_pkey" (id 9b1c…)'));
    expect(status).toBe(500);
    expect(body.error).toBe(GENERIC_ERROR_MESSAGE);
    expect(body.errorId).toMatch(/^[0-9a-f]{8}$/);
    expect(JSON.stringify(body)).not.toContain("constraint");
  });

  it("logs the original error with the route and the same error id", async () => {
    const original = new Error("connection reset by peer");
    const { body } = await run(original);
    expect(logged).toHaveLength(1);
    const [line, err] = logged[0];
    expect(String(line)).toContain("PATCH /api/test");
    expect(String(line)).toContain(String(body.errorId));
    expect(err).toBe(original);
  });

  it("masks a supabase-style error object (not even an Error)", async () => {
    const { status, body } = await run({ message: "permission denied for table invoices", code: "42501" });
    expect(status).toBe(500);
    expect(body.error).toBe(GENERIC_ERROR_MESSAGE);
  });

  it("names the route from a Request when given one", async () => {
    await handleRoute(async () => {
      throw new Error("boom");
    }, new Request("https://app.example.com/api/organizations/o1/quotes/q1?x=1", { method: "POST" }));
    expect(String(logged[0][0])).toContain("POST /api/organizations/o1/quotes/q1");
  });
});

describe("handleRoute passes user-facing errors through", () => {
  it("keeps a UserFacingError's message, status, code and details", async () => {
    const { status, body } = await run(new UserFacingError("Choose a customer first.", { status: 422, code: "no_customer", details: { field: "contact" } }));
    expect(status).toBe(422);
    expect(body).toEqual({ error: "Choose a customer first.", code: "no_customer", field: "contact" });
    expect(logged).toHaveLength(0);
  });

  it("maps the existing typed errors to their statuses", async () => {
    expect((await run(new ValidationError("Bad input."))).status).toBe(400);
    expect((await run(new AuthorizationError("Not allowed."))).status).toBe(403);
    expect((await run(new InvoiceNotFoundError())).status).toBe(404);
    const conflict = await run(new InvoiceConflictError("This quote is already invoiced.", "inv-1"));
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ error: "This quote is already invoiced.", existingInvoiceId: "inv-1" });
  });

  it("keeps Retry-After on a rate limit", async () => {
    const { status, headers } = await run(new TooManyRequestsError("Slow down.", 12.2));
    expect(status).toBe(429);
    expect(headers.get("Retry-After")).toBe("13");
  });

  it("sends the total-change details the quote builder needs to ask", async () => {
    const { status, body } = await run(new QuoteTotalChangedError(56500, 61020));
    expect(status).toBe(409);
    expect(body).toMatchObject({ code: "total_changed", oldTotalCents: 56500, newTotalCents: 61020 });
  });

  it("explains a quote transition in words, not status enums", async () => {
    const { status, body } = await run(new QuoteTransitionError("deposit_paid", "cancelled"));
    expect(status).toBe(409);
    expect(body.error).toBe("This quote is deposit paid, so it can't be voided or replaced.");
  });

  it("passes a checkout error through to the public pay page", async () => {
    const { status, body } = await run(new InvoiceCheckoutError("Nothing is owing on this invoice.", "nothing_owing"));
    expect(status).toBe(409);
    expect(body).toMatchObject({ error: "Nothing is owing on this invoice.", code: "nothing_owing" });
  });

  it("turns a Zod error into a sentence about the field", async () => {
    const parsed = z.object({ services: z.array(z.object({ lengthFt: z.number() })) }).safeParse({ services: [{}] });
    if (parsed.success) throw new Error("expected a failure");
    const { status, body } = await run(parsed.error);
    expect(status).toBe(400);
    expect(body.error).toBe("Length (ft) is required.");
  });

  it("lets a route return its own response untouched", async () => {
    const res = await handleRoute(async () => NextResponse.json({ data: 1 }, { status: 201 }));
    expect(res.status).toBe(201);
  });
});

describe("public pages show only customer-safe text", () => {
  const fallback = "Something went wrong. Please try again.";

  it("shows a message written for the customer", () => {
    expect(customerSafeMessage(409, { error: "Nothing is owing on this invoice." }, fallback)).toBe("Nothing is owing on this invoice.");
  });

  it("never shows a 500's text, but gives the reference", () => {
    expect(customerSafeMessage(500, { error: GENERIC_ERROR_MESSAGE, errorId: "a1b2c3d4" }, fallback)).toBe(`${fallback} (Reference: a1b2c3d4)`);
  });

  it("drops anything that looks technical", () => {
    for (const raw of [
      'Quote 0b8a3c1e-1d2f-4a5b-9c8d-7e6f5a4b3c2d is "approved"',
      "StripeInvalidRequestError: acct_1Abc has no acss_debit",
      "API error 502: Bad Gateway",
      "Cannot read properties of undefined (reading 'id')",
      "<html>502 Bad Gateway</html>",
    ]) {
      expect(customerSafeMessage(409, { error: raw }, fallback)).toBe(fallback);
    }
  });

  it("falls back when there's no message at all", () => {
    expect(customerSafeMessage(502, undefined, fallback)).toBe(fallback);
  });
});
