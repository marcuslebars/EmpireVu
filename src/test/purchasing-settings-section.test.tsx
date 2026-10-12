/** Settings → AI front desk → Purchasing, and the job sheet's read-only materials block. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
vi.mock("@/lib/api-client", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a), resolveApiUrl: (p: string) => p, ApiError: Error }));

import { PurchasingSettingsSection, type PurchasingView } from "@/components/settings/staff/PurchasingSettingsSection";
import { JobMaterialsOrders } from "@/components/jobs/JobMaterialsOrders";

const PATH = "/api/organizations/org-1/companies/co-1/ai-settings/purchasing";
const view: PurchasingView = {
  companyId: "co-1",
  companyName: "Northshore Roofing",
  settings: { enabled: true, enabledIsDefault: true, defaultEnabled: true, leadDays: 2, maxPerDay: 3, defaultFulfilment: "pickup", aiEstimate: true },
  ownerPhoneOnFile: true,
  replyToEmail: "dana@northshore.test",
  aiAvailable: true,
  suppliers: [{ id: "s-1", name: "Home Depot Pro", branch: "Barrie", email: "orders@hd.test", phone: null, accountNumber: "12345", preferred: true, notes: null }],
  catalog: [{ id: "i-1", label: "Shingle roof", unitLabel: "square", recipe: [{ label: "shingles", qtyPerUnit: 3, unit: "bundles", estUnitCostCents: 3850, supplierId: null }] }],
  orders: [{ id: "po-1", poNumber: "PO-1", status: "sent", job: "Jones - Roof replacement", jobDay: "Thu Oct 15", supplier: "Home Depot Pro (Barrie)", fulfilment: "pickup", estTotalCents: 116_200, estimate: false, items: ["22 bundles shingles"] }],
};

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation(() => Promise.resolve(view));
});

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("PurchasingSettingsSection", () => {
  it("shows suppliers, recent orders, and saves settings and recipes to its own route", async () => {
    wrap(<PurchasingSettingsSection orgId="org-1" companyId="co-1" companyName="Northshore Roofing" canManage />);
    await waitFor(() => expect(screen.getByText("Home Depot Pro (Barrie)", { selector: "span" })).toBeInTheDocument());
    expect(screen.getByText(/replies go to dana@northshore.test/)).toBeInTheDocument();
    expect(screen.getByText(/PO-1 · Jones - Roof replacement/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Lead days"), { target: { value: "3" } });
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(PATH, { method: "PATCH", body: JSON.stringify({ leadDays: 3 }) }));

    fireEvent.change(screen.getByLabelText("Price-list service"), { target: { value: "i-1" } });
    expect(screen.getByDisplayValue("shingles")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Save recipe"));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(PATH, {
        method: "POST",
        body: JSON.stringify({ action: "save_recipe", catalogItemId: "i-1", lines: [{ label: "shingles", qtyPerUnit: 3, unit: "bundles", estUnitCostCents: 3850, supplierId: null }] }),
      }),
    );
  });

  it("members: no suppliers, no recipe editor", async () => {
    apiFetch.mockImplementation(() => Promise.resolve({ ...view, suppliers: null, replyToEmail: null }));
    wrap(<PurchasingSettingsSection orgId="org-1" companyId="co-1" companyName="Northshore Roofing" canManage={false} />);
    await waitFor(() => expect(screen.getByText("Only owners and admins can change this.")).toBeInTheDocument());
    expect(screen.queryByText("Suppliers")).toBeNull();
    expect(screen.queryByText("Recipes")).toBeNull();
  });
});

describe("JobMaterialsOrders", () => {
  it("lists what was ordered; nothing when there's no order", async () => {
    apiFetch.mockImplementation(() =>
      Promise.resolve([{ poNumber: "PO-1", status: "sent", statusLabel: "Ordered", supplier: "Home Depot Pro (Barrie)", fulfilment: "pickup", neededBy: "2026-10-14", estimate: false, items: ["22 bundles shingles", "3 rolls underlay"] }]),
    );
    wrap(<JobMaterialsOrders orgId="org-1" bookingId="b-1" />);
    await waitFor(() => expect(screen.getByText("3 rolls underlay")).toBeInTheDocument());
    expect(screen.getByText("Ordered")).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledWith("/api/organizations/org-1/jobs/b-1/materials-orders");

    apiFetch.mockImplementation(() => Promise.resolve([]));
    const { container } = wrap(<JobMaterialsOrders orgId="org-1" bookingId="b-2" />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/organizations/org-1/jobs/b-2/materials-orders"));
    expect(container.textContent).toBe("");
  });
});
