/** Settings → AI front desk → Keep your number. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
vi.mock("@/lib/api-client", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a), resolveApiUrl: (p: string) => p, ApiError: Error }));

import { PortingSettingsSection } from "@/components/settings/staff/PortingSettingsSection";

const PATH = "/api/organizations/org-1/companies/co-1/ai-settings/porting";
const view = {
  companyId: "co-1",
  enabled: true,
  enabledIsDefault: true,
  defaultEnabled: true,
  ring: { enabled: true, seconds: 20, crew: false, screen: true },
  ownerPhone: "(705) 555-9999",
  ownerPhoneVerified: true,
  businessLine: "(705) 555-0142",
  businessLineIsCell: false,
  collectsAccountDetails: true,
  port: null as null | Record<string, unknown>,
  portedLines: [] as string[],
  crewWithCells: 2,
};

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation((_path: string, init?: { method?: string; body?: string }) => {
    if (init?.method === "POST") {
      return Promise.resolve({
        ...view,
        port: { id: "p-1", status: "collecting", statusLabel: "Waiting for your details", numbers: ["+17055550142"], numbersPretty: ["(705) 555-0142"], url: "https://app/port/tok", ownerCanCancel: true, focDate: null, rejectionReason: null },
        started: { url: "https://app/port/tok", texted: true },
      });
    }
    return Promise.resolve(view);
  });
});

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("PortingSettingsSection", () => {
  it("starts a port (texting the owner the form) and shows its status; ring settings PATCH only their key", async () => {
    wrap(<PortingSettingsSection orgId="org-1" companyId="co-1" companyName="Northshore Plumbing" canManage />);
    await waitFor(() => expect(screen.getByText("Keep (705) 555-0142")).toBeInTheDocument());
    expect(screen.getByText(/We'll text the form to \(705\) 555-9999/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Keep (705) 555-0142"));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(PATH, { method: "POST", body: JSON.stringify({ action: "start" }) }));
    await waitFor(() => expect(screen.getByText("Waiting for your details")).toBeInTheDocument());
    expect(screen.getByText("Fill in the form")).toHaveAttribute("href", "https://app/port/tok");
    fireEvent.click(screen.getByText("Ring my team's cells too"));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(PATH, { method: "PATCH", body: JSON.stringify({ ring: { crew: true } }) }));
    expect(document.body.textContent).not.toMatch(/EmpireVu|Twilio/);
  });

  it("read-only for members", async () => {
    wrap(<PortingSettingsSection orgId="org-1" companyId="co-1" companyName="Northshore Plumbing" canManage={false} />);
    await waitFor(() => expect(screen.getByText("Only owners and admins can change this.")).toBeInTheDocument());
    expect(screen.getByLabelText("Keep your number on")).toBeDisabled();
    expect(screen.queryByText("Keep (705) 555-0142")).toBeNull();
  });
});
