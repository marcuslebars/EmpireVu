/**
 * Done-for-you UI: the "We're setting you up" view (replaces the wizard for CrankLeads orgs)
 * and the one-tap forwarding page (/forward/:token) — Android tel: link vs iPhone copy-code,
 * and the landline "Have us set it up" path.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SetupProgressPanel } from "@/components/onboarding/SetupProgress";
import type { ForwardPageView, SetupProgressView } from "@/lib/dfy-api";
import ForwardPage from "@/screens/ForwardPage";

const VIEW: SetupProgressView = {
  tier: "close",
  phonePath: "missed_call_catcher",
  isLive: false,
  items: [
    { key: "number", label: "Text-back number bought", state: "done", detail: "(705) 555-0000" },
    { key: "details", label: "Business details found", state: "done", detail: null },
    { key: "automations", label: "Automations on", state: "done", detail: "Missed-call text-back, follow-ups and reminders." },
    { key: "page", label: "Your page is live", state: "working", detail: "Building your page…" },
  ],
  forwarding: { done: false, url: "https://app.crankleads.test/forward/tok" },
  quickSetupUrl: null,
  extras: [
    { key: "prices", label: "Add your prices", done: false, path: "/settings?section=packs" },
    { key: "payments", label: "Connect payments", done: false, path: "/settings?section=payments" },
  ],
};

describe("SetupProgressPanel", () => {
  it("shows what we did, the one thing left (forwarding link) and optional extras", () => {
    const go = vi.fn();
    render(<SetupProgressPanel view={VIEW} onNavigate={go} />);
    expect(screen.getByRole("heading", { name: "We're setting you up" })).toBeInTheDocument();
    expect(screen.getByText("Text-back number bought")).toBeInTheDocument();
    expect(screen.getByText("(705) 555-0000")).toBeInTheDocument();
    expect(screen.getAllByLabelText("Done")).toHaveLength(3);
    expect(screen.getByLabelText("In progress")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /turn on forwarding/i })).toHaveAttribute("href", "https://app.crankleads.test/forward/tok");
    expect(screen.getByText("Optional")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /connect payments/i }));
    expect(go).toHaveBeenCalledWith("/settings?section=payments");
    // calm + short: no wizard step counts, no "EmpireVu"
    expect(document.body.textContent).not.toMatch(/step \d of|EmpireVu/i);
  });

  it("an unanswered quick setup is a to-do with its link; forwarding done shows a check", () => {
    render(
      <SetupProgressPanel
        view={{
          ...VIEW,
          items: [VIEW.items[0], { key: "details", label: "Business details found", state: "todo", detail: "Tell us your website or Google listing (60 seconds)." }],
          quickSetupUrl: "https://app.crankleads.test/setup/it",
          forwarding: { done: true, url: null },
        }}
      />,
    );
    expect(screen.getByRole("link", { name: /tell us your website/i })).toHaveAttribute("href", "https://app.crankleads.test/setup/it");
    expect(screen.getByText("Call forwarding is on")).toBeInTheDocument();
  });

  it("live: says so", () => {
    render(<SetupProgressPanel view={{ ...VIEW, isLive: true, forwarding: { done: true, url: null } }} />);
    expect(screen.getByRole("heading", { name: "You're live" })).toBeInTheDocument();
  });
});

// ── /forward/:token ──────────────────────────────────────────────────────────

const PAGE: ForwardPageView = {
  businessName: "Jane's Roofing",
  brandName: "CrankLeads",
  phonePath: "missed_call_catcher",
  businessLinePretty: "(416) 555-0101",
  status: "ready",
  statusMessage: null,
  tapped: false,
  helpRequested: false,
  plan: {
    kind: "cell",
    carrierKey: "rogers",
    carrierLabel: "Rogers",
    method: "dial_code",
    number: "+17055550000",
    pretty: "(705) 555-0000",
    code: "**004*+17055550000#",
    deactivate: "##004#",
    telHref: "tel:**004*+17055550000%23",
    confidence: "confident",
    fallbackCodes: [{ condition: "no_answer", label: "When you don't answer", activate: "**61*+17055550000#", deactivate: "##61#" }],
    steps: [],
    providerScript: "Call your phone provider and ask them to forward unanswered and busy calls to (705) 555-0000.",
  },
};

const fetchMock = vi.fn();
let current: ForwardPageView;

function renderForward() {
  return render(
    <MemoryRouter initialEntries={["/forward/AbCdEfGhIjKlMnOpQrStUvWxYz012345"]}>
      <Routes>
        <Route path="/forward/:token" element={<ForwardPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function setUserAgent(ua: string) {
  Object.defineProperty(window.navigator, "userAgent", { value: ua, configurable: true });
}

beforeEach(() => {
  current = PAGE;
  fetchMock.mockReset().mockImplementation(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const { action } = JSON.parse(String(init.body)) as { action: string };
      if (action === "tapped") current = { ...current, tapped: true, statusMessage: "Thanks! We'll call your business line in about a minute to check it — let it ring, don't answer." };
      if (action === "help") current = { ...current, helpRequested: true };
    }
    return new Response(JSON.stringify({ data: current }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ForwardPage", () => {
  it("Android: one big tel: button with # encoded; tapping records it and shows the test note", async () => {
    setUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36");
    renderForward();
    const button = await screen.findByRole("link", { name: /tap to turn on forwarding/i });
    expect(button).toHaveAttribute("href", "tel:**004*+17055550000%23");
    expect(screen.queryByTestId("forward-ios")).toBeNull();
    fireEvent.click(button);
    await screen.findByText(/We'll call your business line in about a minute/);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/public/forward/AbCdEfGhIjKlMnOpQrStUvWxYz012345"),
      expect.objectContaining({ method: "POST", body: JSON.stringify({ action: "tapped" }), keepalive: true }),
    );
  });

  it("iPhone: copy code + paste instructions (iOS won't dial * or # from a link), then 'I've done it'", async () => {
    setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1");
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });
    renderForward();
    await screen.findByTestId("forward-ios");
    expect(screen.queryByRole("link", { name: /tap to turn on forwarding/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /copy code/i }));
    await screen.findByRole("button", { name: /copied/i });
    expect(writeText).toHaveBeenCalledWith("**004*+17055550000#");
    fireEvent.click(screen.getByRole("button", { name: /i've done it/i }));
    await screen.findByText(/We'll call your business line/);
  });

  it("landline: provider steps and 'Have us set it up — we'll call you'", async () => {
    current = {
      ...PAGE,
      plan: { ...PAGE.plan!, kind: "landline", method: "provider", code: null, telHref: null, deactivate: null, carrierLabel: "Bell", steps: ["Call Bell from any phone."] },
    };
    renderForward();
    await screen.findByTestId("forward-provider");
    expect(screen.getByText("Call Bell from any phone.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /have us set it up/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /got it — we'll call you/i })).toBeDisabled());
  });

  it("verified: says it works; unknown token: not valid", async () => {
    current = { ...PAGE, status: "verified", statusMessage: "Forwarding works — missed callers now get a text back." };
    const { unmount } = renderForward();
    await screen.findByTestId("forward-verified");
    expect(screen.getByRole("heading", { name: "Forwarding is on" })).toBeInTheDocument();
    unmount();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: "This link isn't valid." }), { status: 404 }));
    renderForward();
    await screen.findByText("This link isn't valid");
  });
});
