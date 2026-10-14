import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * D7 review fix: the quote email's sender is looked up by the QUOTE's company id. If the company
 * row fails to load, the lookup still runs for that company (and a failed lookup reports the send
 * as not delivered) instead of silently falling to the platform default sender.
 */
const sendEmail = vi.fn();
const loadCompanyFromAddress = vi.fn();
let companyRow: Record<string, unknown> | null = { id: "c1", name: "A1 Marine Storage" };

vi.mock("@/server/outbound/email", () => ({ sendEmail: (...a: unknown[]) => sendEmail(...a) }));
vi.mock("@/server/outbound/company-sender", () => ({
  loadCompanyFromAddress: (...a: unknown[]) => loadCompanyFromAddress(...a),
}));
vi.mock("@/server/services/quotes/public-service", () => ({ recordPublicEvent: async () => undefined }));
vi.mock("@/server/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({
    from(table: string) {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () =>
          Promise.resolve({
            data:
              table === "quotes"
                ? {
                    id: "q1",
                    organization_id: "org1",
                    company_id: "c1",
                    contact_id: "ct1",
                    public_token: "tok",
                    quote_number: "Q-1",
                    title: "Winter storage",
                    currency: "CAD",
                    total_cents: 400,
                    deposit_cents: 100,
                    valid_until: "2026-09-30T00:00:00.000Z",
                    expires_at: "2026-09-30T00:00:00.000Z",
                  }
                : table === "companies"
                  ? companyRow
                  : table === "organizations"
                    ? { platform_brand: "empirevu" }
                    : { email: "pat@example.com", first_name: "Pat" },
            error: table === "companies" && !companyRow ? { message: "read failed" } : null,
          }),
      };
      return chain;
    },
  }),
}));

const { sendQuoteEmail } = await import("@/server/services/quotes/notify");

beforeEach(() => {
  sendEmail.mockReset().mockResolvedValue(undefined);
  loadCompanyFromAddress.mockReset().mockResolvedValue(null);
  companyRow = { id: "c1", name: "A1 Marine Storage" };
});

describe("quote email sender lookup (D7)", () => {
  it("looks the sender up by the quote's company id", async () => {
    await sendQuoteEmail("q1");
    expect(loadCompanyFromAddress).toHaveBeenCalledWith("c1");
  });

  it("still looks it up by the quote's company id when the company row failed to load", async () => {
    companyRow = null;
    await sendQuoteEmail("q1");
    expect(loadCompanyFromAddress).toHaveBeenCalledWith("c1");
    expect(loadCompanyFromAddress).not.toHaveBeenCalledWith(null);
  });

  it("a failed sender lookup does not send from the platform default", async () => {
    loadCompanyFromAddress.mockRejectedValue(new Error("company sender unavailable"));
    await sendQuoteEmail("q1");
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
