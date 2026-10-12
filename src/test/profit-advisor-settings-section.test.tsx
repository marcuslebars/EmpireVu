/** Settings → AI front desk → Profit advisor. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
vi.mock("@/lib/api-client", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a), resolveApiUrl: (p: string) => p, ApiError: Error }));

import { ProfitAdvisorSettingsSection, type ProfitAdvisorView } from "@/components/settings/staff/ProfitAdvisorSettingsSection";

const PATH = "/api/organizations/org-1/companies/co-1/ai-settings/profit-advisor";
const view: ProfitAdvisorView = {
  companyId: "co-1",
  companyName: "Northshore Roofing",
  settings: { enabled: true, enabledIsDefault: true, defaultEnabled: true, weekly: { enabled: true, day: 5, time: "15:00" }, pricingCheck: { enabled: true }, tightCushionCents: 0 },
  ownerPhoneOnFile: true,
  manager: true,
  lastWeekly: { date: "2026-10-16", status: "sent", body: "This week: 6 jobs done, $8,420 billed, profit about $3,100 (37%)." },
  forecast: {
    summary: "Next 30 days: about $11k in, $7k out - fine.",
    windows: [
      { days: 30, inLikelyCents: 1_100_000, inLowCents: 800_000, outLikelyCents: 700_000, outLowCents: 770_000 },
      { days: 60, inLikelyCents: 1_500_000, inLowCents: 1_000_000, outLikelyCents: 1_400_000, outLowCents: 1_540_000 },
      { days: 90, inLikelyCents: 1_600_000, inLowCents: 1_100_000, outLikelyCents: 2_100_000, outLowCents: 2_310_000 },
    ],
    tight30: { tight: false, date: null, shortCents: 0 },
    tight90: { tight: true, date: "2026-12-20", shortCents: 500_000 },
    notes: ["1 crew has no pay rate - payroll uses the average rate."],
  },
  pricing: {
    companyMarginPct: 35,
    items: [{ label: "Gutter cleaning", rateCents: 18_900, unitLabel: null, jobs: 18, marginPct: 12, quotes: 12, winRatePct: 92, underpriced: true, proposalCents: 21_500, proposalPct: 14, held: null }],
    changes: [{ id: "pc-1", label: "Roof vent", oldRateCents: 9_000, newRateCents: 10_000, appliedAt: "2026-09-01T14:00:00Z", before: { marginPct: 15, winRatePct: 90, jobs: 6 }, after: { jobs: 3, marginPct: 24, quotes: 4, winRatePct: 75 } }],
    pending: [],
  },
  disclaimer: "Estimates from your app data - not financial advice.",
};

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation(() => Promise.resolve(view));
});

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("ProfitAdvisorSettingsSection", () => {
  it("shows the forecast, the price check and past changes; saves to its own route", async () => {
    wrap(<ProfitAdvisorSettingsSection orgId="org-1" companyId="co-1" companyName="Northshore Roofing" canManage />);
    await waitFor(() => expect(screen.getByText("Next 30 days: about $11k in, $7k out - fine.")).toBeInTheDocument());
    expect(screen.getByText(/Looks tight later: around Dec 20 \(about \$5,000 short\)/)).toBeInTheDocument();
    expect(screen.getByText(/would ask \$215 \(\+14%\)/)).toBeInTheDocument();
    expect(screen.getByText(/Roof vent: raised \$90 to \$100 on Sep 1 - 3 jobs since at 24% margin \(was 15%\)/)).toBeInTheDocument();
    expect(screen.getByText(/Estimates from your app data - not financial advice\./)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Weekly text day"), { target: { value: "1" } });
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(PATH, { method: "PATCH", body: JSON.stringify({ weekly: { day: 1 } }) }));
    fireEvent.click(screen.getByLabelText("Monthly price check"));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(PATH, { method: "PATCH", body: JSON.stringify({ pricingCheck: { enabled: false } }) }));
    fireEvent.change(screen.getByLabelText("Tight cushion"), { target: { value: "250000" } });
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(PATH, { method: "PATCH", body: JSON.stringify({ tightCushionCents: 250_000 }) }));
  });

  it("members: switches only, can't change them", async () => {
    apiFetch.mockImplementation(() => Promise.resolve({ ...view, manager: false, forecast: null, pricing: null, lastWeekly: null }));
    wrap(<ProfitAdvisorSettingsSection orgId="org-1" companyId="co-1" companyName="Northshore Roofing" canManage={false} />);
    await waitFor(() => expect(screen.getByText("Only owners and admins can change this or see the numbers.")).toBeInTheDocument());
    expect(screen.queryByText("Cash forecast")).toBeNull();
    expect((screen.getByLabelText("Profit advisor on") as HTMLInputElement).disabled).toBe(true);
  });
});
