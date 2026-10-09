/** Settings → AI front desk: one panel, three sections in order, per company. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
vi.mock("@/lib/api-client", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
vi.mock("@/lib/org-context", () => ({ useOrg: () => ({ organizationId: "org-1", companyId: "co-1" }) }));
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ session: { organizations: [{ id: "org-1", membershipRole: "owner" }] } }),
}));
vi.mock("@/lib/api-hooks", () => ({
  useCompanies: () => ({ data: [{ id: "co-1", name: "Northshore Snow & Lawn" }], isLoading: false }),
}));

import { AiFrontDeskSettings } from "@/components/settings/AiFrontDeskSettings";
import { AI_FRONT_DESK_SECTIONS } from "@/components/settings/ai-front-desk-sections";

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation((path: string) => {
    if (path.endsWith("/ai-settings/sms-agent")) {
      return Promise.resolve({
        companyId: "co-1", enabled: true, autonomy: "standard", enabledIsDefault: true, defaultEnabled: true,
        stats: { conversations30d: 4, aiReplies30d: 9, withOwner: 1, pendingApprovals: 0 },
      });
    }
    if (path.endsWith("/ai-settings/call-answering")) {
      // apiFetch returns the route's `data` (it unwraps { data } itself).
      return Promise.resolve({
        companyId: "co-1", companyName: "Northshore Snow & Lawn", mode: "ai", modeExplicit: false, includedMinutes: 100,
        allowance: { scope: "company", source: "call_answering", includedMinutes: 100, usedMinutes: 12, remainingMinutes: 88, month: "2026-10" },
        agentKind: "message", available: true,
        preview: { greeting: "Hi, thanks for calling Northshore Snow & Lawn.", collects: ["Name"], never: ["Quotes prices"], afterCall: ["Texts the caller"] },
      });
    }
    if (path.endsWith("/ai-settings/weekly-report")) {
      return Promise.resolve({ enabled: true, channels: ["sms", "email"], isCrankleads: true, brandName: "CrankLeads", ownerPhoneOnFile: true, ownerEmailOnFile: true, canManage: true });
    }
    return Promise.reject(new Error(`unexpected ${path}`));
  });
});

describe("AI front desk settings panel", () => {
  it("shows Text conversations, Phone answering and Weekly report for the company, in that order", async () => {
    wrap(<AiFrontDeskSettings sections={AI_FRONT_DESK_SECTIONS} />);
    await waitFor(() => expect(screen.getByText(/AI call minutes in October/)).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: /send a test to me/i })).toBeInTheDocument());
    const headings = screen.getAllByRole("heading", { level: 4 }).map((h) => h.textContent);
    expect(headings).toEqual(["Text conversations", "Phone answering", "Weekly report"]);
    expect(screen.getByText("What happens when Northshore Snow & Lawn misses a call.")).toBeInTheDocument();
    const paths = apiFetch.mock.calls.map((c) => c[0] as string);
    expect(paths).toEqual(expect.arrayContaining([
      "/api/organizations/org-1/companies/co-1/ai-settings/sms-agent",
      "/api/organizations/org-1/companies/co-1/ai-settings/call-answering",
      "/api/organizations/org-1/companies/co-1/ai-settings/weekly-report",
    ]));
    expect(document.body.textContent).not.toMatch(/EmpireVu/);
  });
});
