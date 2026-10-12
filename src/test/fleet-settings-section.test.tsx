/** Settings → AI front desk → Fleet & equipment. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
vi.mock("@/lib/api-client", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a), resolveApiUrl: (p: string) => p, ApiError: Error }));

import { FleetSettingsSection, type FleetView } from "@/components/settings/staff/FleetSettingsSection";

const PATH = "/api/organizations/org-1/companies/co-1/ai-settings/fleet";
const view: FleetView = {
  companyId: "co-1",
  companyName: "Northshore Roofing",
  settings: { enabled: true, reminders: true, defaultEnabled: true, enabledIsDefault: true },
  ownerPhoneOnFile: true,
  vehicles: [
    {
      id: "v-1",
      name: "Truck 2",
      year: 2019,
      make: "Ford",
      model: "F-150",
      plate: "ABCD 123",
      vin: null,
      driverProfileId: null,
      driverName: "Mike Dunn",
      odometerKm: 84_200,
      odometerWords: "84,200 km on Oct 12, 2026",
      plateStickerDue: "2026-10-19",
      plateTone: "soon",
      safetyInspectionRequired: false,
      safetyInspectionDue: null,
      safetyTone: null,
      notes: null,
      services: [{ id: "s-1", label: "Oil change", everyKm: 8000, everyMonths: null, lastDoneKm: 76_100, lastDoneOn: null, words: "Oil change (every 8,000 km): overdue by about 100 km", tone: "late" }],
    },
  ],
  equipment: [{ id: "e-1", name: "Mini-ex", serial: null, valueCents: 4_200_000, status: "out", location: "Jones job", hours: 390, serviceEveryHours: 250, serviceEveryMonths: null, lastServicedOn: null, statusWords: "out - Jones job since Oct 10", serviceWords: "service in 10 hours", tone: "soon" }],
  rentals: [{ id: "r-1", item: "plate compactor", vendor: "Wacker", vendorPhone: null, dueBackAt: "2026-10-13T12:00:00Z", rateCentsPerDay: null, returnedAt: null, words: "Wacker plate compactor, due back Oct 13 8am", tone: "soon" }],
  vehicleInsurance: [{ issuer: "Intact", expiresOn: "2027-03-31", status: "current" }],
  crew: [{ profileId: "p-1", name: "Mike Dunn" }],
  attention: ["Truck 2 oil change overdue (about 8,100 km since last)"],
};

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation(() => Promise.resolve(view));
});

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("FleetSettingsSection", () => {
  it("shows the fleet and sends its own actions", async () => {
    wrap(<FleetSettingsSection orgId="org-1" companyId="co-1" companyName="Northshore Roofing" canManage />);
    await waitFor(() => expect(screen.getByText("Truck 2")).toBeInTheDocument());
    expect(screen.getByText("Truck 2 oil change overdue (about 8,100 km since last)")).toBeInTheDocument();
    expect(screen.getByText(/Intact - expires 2027-03-31/)).toBeInTheDocument();
    expect(screen.getByText("out - Jones job since Oct 10")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Daily heads-up text"));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(PATH, { method: "PATCH", body: JSON.stringify({ reminders: false }) }));

    fireEvent.click(screen.getByText("Done today"));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(PATH, { method: "POST", body: JSON.stringify({ action: "service_done", vehicleId: "v-1", label: "Oil change" }) }));

    fireEvent.click(screen.getByText("Returned"));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(PATH, { method: "POST", body: JSON.stringify({ action: "return_rental", rentalId: "r-1" }) }));

    fireEvent.click(screen.getByText("Add rental"));
    fireEvent.change(screen.getByLabelText("What"), { target: { value: "mini-ex" } });
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "Sunbelt" } });
    fireEvent.change(screen.getByLabelText("Due back"), { target: { value: "2026-10-15T17:00" } });
    fireEvent.change(screen.getByLabelText("$ per day"), { target: { value: "380" } });
    fireEvent.click(screen.getByText("Save rental"));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(PATH, {
        method: "POST",
        body: JSON.stringify({ action: "save_rental", rental: { item: "mini-ex", vendor: "Sunbelt", vendorPhone: null, dueBackLocal: "2026-10-15T17:00", rateCentsPerDay: 38_000 } }),
      }),
    );
  });

  it("members read only", async () => {
    wrap(<FleetSettingsSection orgId="org-1" companyId="co-1" companyName="Northshore Roofing" canManage={false} />);
    await waitFor(() => expect(screen.getByText("Only owners and admins can change this.")).toBeInTheDocument());
    expect(screen.queryByText("Add vehicle")).toBeNull();
    expect(screen.queryByText("Done today")).toBeNull();
  });
});
