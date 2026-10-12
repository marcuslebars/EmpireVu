/** Settings → AI front desk → Email inbox (docs/ai-staff.md → "Email inbox"). */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
vi.mock("@/lib/api-client", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a), resolveApiUrl: (p: string) => p, ApiError: Error }));

import { EmailClerkSettingsSection, type EmailClerkView } from "@/components/settings/staff/EmailClerkSettingsSection";

const PATH = "/api/organizations/org-1/companies/co-1/ai-settings/email-clerk";
const ADDRESS = "northshore-roofing-k3j9x2ab@in.crankleads.test";
const view: EmailClerkView = {
  companyId: "co-1",
  companyName: "Northshore Roofing",
  configured: true,
  settings: { enabled: true, enabledIsDefault: true, defaultEnabled: true, draftReplies: true, digest: true, digestTime: "16:00" },
  ownerPhoneOnFile: true,
  aiAvailable: true,
  inbox: { address: ADDRESS, forwardingConfirmedAt: null, forwardingRequestedAt: null, lastReceivedAt: null },
  counts: { customer: 1, newsletter: 3 },
  recent: [
    { id: "e-1", receivedAt: "2026-10-12T14:00:00Z", from: "Dana Jones", fromAddress: "dana@x.test", subject: "Roof quote", category: "customer", summary: "Can you quote a full roof?", replyStatus: "awaiting_owner", draft: "Hi Dana,\n\nThanks for reaching out.", approvalCode: 12, attachments: 1 },
  ],
};

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation(() => Promise.resolve(view));
});

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("EmailClerkSettingsSection", () => {
  it("shows the address with a copy button, forwarding steps, the recent email with its draft; saves to its own route", async () => {
    wrap(<EmailClerkSettingsSection orgId="org-1" companyId="co-1" companyName="Northshore Roofing" canManage />);
    await waitFor(() => expect(screen.getByTestId("email-inbox-address")).toHaveTextContent(ADDRESS));
    expect(screen.getByRole("button", { name: "Copy address" })).toBeInTheDocument();
    expect(screen.getByText("Not forwarding yet. Set your mailbox to forward here:")).toBeInTheDocument();
    expect(screen.getByText("Gmail")).toBeInTheDocument();
    expect(screen.getByText("Outlook / Microsoft 365")).toBeInTheDocument();
    expect(screen.getByText(/Last 7 days: 1 customer · 3 newsletter/)).toBeInTheDocument();
    expect(screen.getByText(/Draft waiting on your Y \(#12\)/)).toBeInTheDocument();
    expect(screen.getByText("Drafted reply")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Digest time"), { target: { value: "17:00" } });
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(PATH, { method: "PATCH", body: JSON.stringify({ digestTime: "17:00" }) }));
  });

  it("forwarding working → no steps", async () => {
    apiFetch.mockImplementation(() => Promise.resolve({ ...view, inbox: { ...view.inbox, forwardingConfirmedAt: "2026-10-12T14:00:00Z", lastReceivedAt: "2026-10-12T14:00:00Z" } }));
    wrap(<EmailClerkSettingsSection orgId="org-1" companyId="co-1" companyName="Northshore Roofing" canManage />);
    await waitFor(() => expect(screen.getByText(/Forwarding works/)).toBeInTheDocument());
    expect(screen.queryByText("Gmail")).toBeNull();
  });

  it("no inbox yet: owners get a button that makes it (POST create_inbox)", async () => {
    apiFetch.mockImplementation((_p: string, init?: { method?: string }) => Promise.resolve(init?.method === "POST" ? view : { ...view, inbox: null, recent: null, counts: null }));
    wrap(<EmailClerkSettingsSection orgId="org-1" companyId="co-1" companyName="Northshore Roofing" canManage />);
    await waitFor(() => expect(screen.getByText("Get my inbox address")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Get my inbox address"));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(PATH, { method: "POST", body: JSON.stringify({ action: "create_inbox" }) }));
    await waitFor(() => expect(screen.getByTestId("email-inbox-address")).toHaveTextContent(ADDRESS));
  });

  it("not set up on this server", async () => {
    apiFetch.mockImplementation(() => Promise.resolve({ ...view, configured: false, inbox: null, recent: null, counts: null }));
    wrap(<EmailClerkSettingsSection orgId="org-1" companyId="co-1" companyName="Northshore Roofing" canManage />);
    await waitFor(() => expect(screen.getByText("Email inbox isn't set up on this server yet.")).toBeInTheDocument());
  });

  it("members: no address, can't change anything", async () => {
    apiFetch.mockImplementation(() => Promise.resolve({ ...view, inbox: null, recent: null, counts: null }));
    wrap(<EmailClerkSettingsSection orgId="org-1" companyId="co-1" companyName="Northshore Roofing" canManage={false} />);
    await waitFor(() => expect(screen.getByText("Only owners and admins can change this.")).toBeInTheDocument());
    expect(screen.queryByTestId("email-inbox-address")).toBeNull();
    expect(screen.getByLabelText("Email inbox on")).toBeDisabled();
  });
});
