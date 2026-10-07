/**
 * Hosted lead page (/f/:formKey): renders the company + catalog labels from the public
 * GET, never credits the platform (no "Powered by"), hides the header in
 * embed mode, and submits to the public endpoint with phone-or-email + consent.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import PublicLeadFormPage from "@/screens/PublicLeadFormPage";

const KEY = `evpk_${"c".repeat(48)}`;
const config = {
  form: { formType: "quote", smsConsentText: "Yes, Kirk Snow Removal may text me. Reply STOP to opt out." },
  company: { name: "Kirk Snow Removal", logoUrl: null, phone: "+17055550100", primaryColor: "#1d4ed8" },
  services: ["Driveway clearing", "Salting"],
};

const fetchMock = vi.fn();

function renderAt(search = "") {
  window.history.replaceState({}, "", `/f/${KEY}${search}`);
  return render(
    <MemoryRouter initialEntries={[`/f/${KEY}${search}`]}>
      <Routes>
        <Route path="/f/:formKey" element={<PublicLeadFormPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchMock.mockReset().mockImplementation(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      return new Response(JSON.stringify({ data: { ok: true, leadId: "lead_x" } }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: config }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PublicLeadFormPage", () => {
  it("shows the company and its services + Other, with no platform credit", async () => {
    renderAt();
    expect(await screen.findByText("Kirk Snow Removal")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Driveway clearing" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Other" })).toBeInTheDocument();
    expect(screen.queryByText(/Powered by/i)).toBeNull();
    expect(document.body.textContent ?? "").not.toMatch(/EmpireVu|CrankLeads/i);
  });

  it("embed mode hides the header", async () => {
    renderAt("?embed=1&page=https%3A%2F%2Fkirksnow.ca%2Fquote");
    await screen.findByLabelText("Your name");
    expect(screen.queryByRole("heading", { name: "Kirk Snow Removal" })).toBeNull();
  });

  it("submits phone + consent + parent page to the public endpoint and shows success", async () => {
    renderAt("?embed=1&page=https%3A%2F%2Fkirksnow.ca%2Fquote&utm_source=gbp");
    fireEvent.change(await screen.findByLabelText("Your name"), { target: { value: "Pat Plow" } });
    fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "705-555-0199" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /get my quote/i }));

    expect(await screen.findByText(/we got it/i)).toBeInTheDocument();
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST");
    expect(post?.[0]).toContain(`/api/public/forms/${KEY}`);
    const body = JSON.parse((post?.[1] as RequestInit).body as string);
    expect(body).toMatchObject({ name: "Pat Plow", phone: "705-555-0199", smsConsent: true, page: "https://kirksnow.ca/quote", utm: { utm_source: "gbp" } });
    expect(body.organizationId).toBeUndefined();
    expect(body.companyId).toBeUndefined();
  });

  it("requires a phone or an email before posting", async () => {
    renderAt();
    fireEvent.change(await screen.findByLabelText("Your name"), { target: { value: "No Contact" } });
    const button = screen.getByRole("button", { name: /get my quote/i });
    expect(button).toBeDisabled();
    await waitFor(() => expect(fetchMock.mock.calls.every(([, init]) => (init as RequestInit | undefined)?.method !== "POST")).toBe(true));
  });

  it("framed (even without ?embed=1) on a restricted form with no browser-reported parent origin → submit blocked", async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") throw new Error("must not post");
      return new Response(JSON.stringify({ data: { ...config, form: { ...config.form, restrictedToSites: true } } }), { status: 200 });
    });
    const frame = document.body.appendChild(document.createElement("iframe"));
    const parentSpy = vi.spyOn(window, "parent", "get").mockReturnValue(frame.contentWindow as Window);
    const refSpy = vi.spyOn(document, "referrer", "get").mockReturnValue("");
    try {
      renderAt();
      fireEvent.change(await screen.findByLabelText("Phone"), { target: { value: "705-555-0199" } });
      expect(screen.getByText(/can.t confirm the website/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /get my quote/i })).toBeDisabled();
    } finally {
      parentSpy.mockRestore();
      refSpy.mockRestore();
    }
  });

  it("framed with a referrer origin sends it as the embedding origin (Firefox path)", async () => {
    const frame = document.body.appendChild(document.createElement("iframe"));
    const parentSpy = vi.spyOn(window, "parent", "get").mockReturnValue(frame.contentWindow as Window);
    const refSpy = vi.spyOn(document, "referrer", "get").mockReturnValue("https://kirksnow.ca/quote");
    try {
      renderAt("?page=https%3A%2F%2Fforged.example%2F");
      fireEvent.change(await screen.findByLabelText("Phone"), { target: { value: "705-555-0199" } });
      fireEvent.click(screen.getByRole("button", { name: /get my quote/i }));
      await screen.findByText(/we got it/i);
      const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST");
      const body = JSON.parse((post?.[1] as RequestInit).body as string);
      expect(body.framed).toBe(true);
      expect(body.embedOrigin).toBe("https://kirksnow.ca"); // never taken from the ?page= param
    } finally {
      parentSpy.mockRestore();
      refSpy.mockRestore();
    }
  });
});
