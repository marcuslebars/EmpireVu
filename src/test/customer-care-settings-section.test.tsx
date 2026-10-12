/** Settings → AI front desk → Customer care & warranty. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
vi.mock("@/lib/api-client", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a), resolveApiUrl: (p: string) => p, ApiError: Error }));

import { CustomerCareSettingsSection, type CustomerCareView } from "@/components/settings/staff/CustomerCareSettingsSection";

const PATH = "/api/organizations/org-1/companies/co-1/ai-settings/customer-care";
const view: CustomerCareView = {
  companyId: "co-1",
  companyName: "Northshore Roofing",
  settings: { enabled: true, enabledIsDefault: true, defaultEnabled: true, checkins: { enabled: true, time: "10:00", delayDays: 1, minJobCents: 0 }, warranty: { months: 12, terms: null } },
  smsAgentOn: true,
  ownerPhoneOnFile: true,
  stats: { checkinsSent30: 14, answered30: 9, averageRating: 4.6, ratings30: 9, openCases: 1 },
  cases: [{ id: "case-1", customer: "Dana Jones", phone: "+17055550123", kind: "complaint", status: "open", rating: 2, summary: "still leaking by the chimney", job: "roof", opened: "2026-10-12", stage: "waiting on you" }],
  catalog: [{ id: "i-1", label: "Roof replacement", months: null, terms: null }],
  equipment: [{ id: "eq-1", customer: "Dana Jones", name: "Lennox EL296", serial: "5819", installedOn: "2025-11-02", warrantyEnds: "2035-11-02" }],
};

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation(() => Promise.resolve(view));
});

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("CustomerCareSettingsSection", () => {
  it("shows the numbers, cases and equipment; saves to its own route", async () => {
    wrap(<CustomerCareSettingsSection orgId="org-1" companyId="co-1" companyName="Northshore Roofing" canManage />);
    await waitFor(() => expect(screen.getByText("4.6/5")).toBeInTheDocument());
    expect(screen.getByText(/Dana Jones · Unhappy 2\/5/)).toBeInTheDocument();
    expect(screen.getByText("Lennox EL296")).toBeInTheDocument();
    expect(screen.getByText(/Your review requests go out exactly as before/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Check-in time"), { target: { value: "11:00" } });
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(PATH, { method: "PATCH", body: JSON.stringify({ checkins: { time: "11:00" } }) }));
    fireEvent.change(screen.getByLabelText("Warranty for Roof replacement"), { target: { value: "60" } });
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(PATH, { method: "POST", body: JSON.stringify({ action: "save_term", catalogItemId: "i-1", months: 60 }) }));
    fireEvent.click(screen.getByText("Resolved"));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(PATH, { method: "POST", body: JSON.stringify({ action: "resolve_case", caseId: "case-1", outcome: "resolved" }) }));
  });

  it("members: no cases, read-only; a note when the texting assistant is off", async () => {
    apiFetch.mockImplementation(() => Promise.resolve({ ...view, cases: null, smsAgentOn: false }));
    wrap(<CustomerCareSettingsSection orgId="org-1" companyId="co-1" companyName="Northshore Roofing" canManage={false} />);
    await waitFor(() => expect(screen.getByText("Only owners and admins can change this.")).toBeInTheDocument());
    expect(screen.queryByText("Open cases", { selector: "h4" })).toBeNull();
    expect(screen.getByText(/Turn on Text conversations above too/)).toBeInTheDocument();
  });
});
