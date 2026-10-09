/** Dashboard Approvals card: pending with Approve / Skip, recent decisions, hidden when empty. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
vi.mock("@/lib/api-client", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

import { ApprovalsCard } from "@/components/approvals/ApprovalsCard";

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const pending = {
  id: "a-1", companyId: "co-1", companyName: "Northshore", contactId: null, kind: "send_quote",
  summary: "Quote for Dana: $650 seasonal contract.", status: "pending", shortCode: 1,
  createdAt: new Date().toISOString(), expiresAt: null, decidedAt: null, decidedVia: null, resultMessage: null,
};

beforeEach(() => apiFetch.mockReset());

describe("ApprovalsCard", () => {
  it("lists pending items and approves through the decide route", async () => {
    apiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (init?.method === "POST") return Promise.resolve({ outcome: "done", message: "Sent the $650 quote to Dana." });
      return Promise.resolve({ pending: [pending], recent: [{ ...pending, id: "a-0", status: "rejected", decidedVia: "sms", decidedAt: new Date().toISOString(), summary: "Book Sam." }] });
    });
    wrap(<ApprovalsCard orgId="org-1" />);
    expect(await screen.findByText("Quote for Dana: $650 seasonal contract.")).toBeInTheDocument();
    expect(screen.getByText(/Skipped by text/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /approve/i }));
    await waitFor(() => expect(screen.getByText("Sent the $650 quote to Dana.")).toBeInTheDocument());
    expect(apiFetch).toHaveBeenCalledWith("/api/organizations/org-1/approvals/a-1/decide", expect.objectContaining({ method: "POST", body: JSON.stringify({ decision: "approve" }) }));
    expect(document.body.textContent).not.toMatch(/EmpireVu/);
  });

  it("renders nothing when there's nothing to show", async () => {
    apiFetch.mockResolvedValue({ pending: [], recent: [] });
    const { container } = wrap(<ApprovalsCard orgId="org-1" />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });
});
