/**
 * /welcome/crankleads?session_id=… — polls the purchase status, shows "setting up", then
 * "Done! Check your email (j***@…)" with a resend button and an "Open EmpireVu" link.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import CrankleadsWelcomePage from "@/screens/CrankleadsWelcomePage";

const SESSION = "cs_test_a1b2c3d4e5f6g7h8i9";
const fetchMock = vi.fn();
let statuses: string[];

function renderPage(search = `?session_id=${SESSION}`) {
  return render(
    <MemoryRouter initialEntries={[`/welcome/crankleads${search}`]}>
      <Routes>
        <Route path="/welcome/crankleads" element={<CrankleadsWelcomePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  statuses = ["provisioning", "ready"];
  fetchMock.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") return new Response(JSON.stringify({ data: { sent: true } }), { status: 200 });
    expect(url).toContain(`/api/public/crankleads/checkout/${SESSION}`);
    const status = statuses.length > 1 ? statuses.shift() : statuses[0];
    return new Response(
      JSON.stringify({ data: { status, businessName: "Jane's Roofing", emailMasked: "j***@roofco.example" } }),
      { status: 200 },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("CrankLeads welcome page", () => {
  it("shows setting-up, then done with the masked email, resend and Open EmpireVu", async () => {
    renderPage();
    await screen.findByText(/setting up your system/i);
    await vi.advanceTimersByTimeAsync(3100);
    await screen.findByTestId("welcome-ready");
    expect(screen.getByText("j***@roofco.example")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open EmpireVu" })).toHaveAttribute("href", "/signin");

    fireEvent.click(screen.getByRole("button", { name: /resend the email/i }));
    await screen.findByText(/Sent!/);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`/api/public/crankleads/checkout/${SESSION}/resend`),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("tells the buyer the payment is safe when provisioning failed", async () => {
    statuses = ["failed"];
    renderPage();
    await screen.findByTestId("welcome-delayed");
    expect(screen.getByText(/Your payment is safe/)).toBeInTheDocument();
  });

  it("handles a missing session id", async () => {
    renderPage("");
    await waitFor(() => expect(screen.getByTestId("welcome-missing")).toBeInTheDocument());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
