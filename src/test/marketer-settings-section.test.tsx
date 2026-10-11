/** Settings → AI front desk → Marketing section. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
vi.mock("@/lib/api-client", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

import { MarketerSettingsSection } from "@/components/settings/staff/MarketerSettingsSection";

const view = {
  companyId: "co-1",
  crankleads: true,
  canManage: true,
  settings: {
    winBack: { enabled: true, monthsMin: 9, monthsMax: 24, weeklyCap: 150, perHour: 30, startHour: 10, endHour: 19, days: [1, 2, 3, 4, 5, 6] },
    reviewReplies: { enabled: true },
    googlePosts: { enabled: false },
  },
  lastCampaign: { status: "done", createdAt: "2026-10-02T15:00:00Z", audienceCount: 40, sent: 38, queued: 0, skipped: 2, replies: 6, bookings: 3, quotes: 1 },
  google: { connected: true, rating: 4.6, reviewCount: 41, repliesWaiting: 1, postsWaiting: 0 },
};

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation((_path: string, init?: { method?: string; body?: string }) =>
    Promise.resolve(init?.method === "PATCH" ? { ...view, settings: { ...view.settings, googlePosts: { enabled: true } } } : view),
  );
});

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("MarketerSettingsSection", () => {
  it("shows the three switches, the last campaign and the Google numbers; a switch PATCHes only its key", async () => {
    wrap(<MarketerSettingsSection orgId="org-1" companyId="co-1" companyName="Northshore Roofing" canManage />);
    await waitFor(() => expect(screen.getByText("Win-back texts to past customers")).toBeInTheDocument());
    expect(screen.getByText(/38 sent · 6 replied · 3 booked · 1 quoted/)).toBeInTheDocument();
    expect(screen.getByText(/4\.6 stars from 41 reviews · 1 reply waiting for you/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/EmpireVu/);
    fireEvent.click(screen.getByLabelText("Weekly Google post"));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/organizations/org-1/companies/co-1/ai-settings/marketing", { method: "PATCH", body: JSON.stringify({ googlePosts: { enabled: true } }) }));
  });

  it("read-only for members", async () => {
    wrap(<MarketerSettingsSection orgId="org-1" companyId="co-1" companyName="Northshore Roofing" canManage={false} />);
    await waitFor(() => expect(screen.getByText("Only owners and admins can change this.")).toBeInTheDocument());
    expect(screen.getByLabelText("Win-back texts")).toBeDisabled();
  });
});
