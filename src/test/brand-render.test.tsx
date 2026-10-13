/**
 * BrandProvider, Everdoer rebrand PR 2: every host and every org shows Everdoer (logo, favicon,
 * title; one theme, no data-brand) and never "EmpireVu" or "CrankLeads". The product line still
 * follows the host (signed out) or the active org (signed in), and product-line copy
 * (receptionistCopy) still differs.
 */
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FakeSession = {
  activeOrganizationId: string | null;
  organizations: Array<{ id: string; name: string; slug: string; membershipRole: string; platformBrand?: string }>;
};
const auth: { status: "loading" | "authenticated" | "unauthenticated"; session: FakeSession | null } = {
  status: "unauthenticated",
  session: null,
};

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    status: auth.status,
    session: auth.session,
    signIn: vi.fn(),
    signInWithOAuth: vi.fn(),
  }),
}));
vi.mock("@/lib/supabase", () => ({ getSupabaseConfigDiagnostic: () => ({ isConfigured: true }), supabase: {} }));

import { AppSidebar } from "@/components/layout/AppSidebar";
import { BrandProvider, useBrand } from "@/lib/brand-context";
import SignInPage from "@/screens/SignInPage";
import { EVERDOER_BRAND, receptionistCopy } from "@/lib/platform-brand";

function withHost(hostname: string) {
  vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, hostname } as Location);
}

function Probe() {
  const brand = useBrand();
  return (
    <>
      <span data-testid="brand-name">{brand.name}</span>
      <span data-testid="product-line">{brand.productLine}</span>
      <span data-testid="receptionist">{receptionistCopy("Call with Marina", brand)}</span>
    </>
  );
}

const OLD_NAMES = /empire\s*vu|crank\s*leads/i;

function renderApp(ui: React.ReactNode, path = "/") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <BrandProvider>
        <Probe />
        {ui}
      </BrandProvider>
    </MemoryRouter>,
  );
}

function iconHrefs(): string[] {
  return Array.from(document.head.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')).map((l) => l.getAttribute("href") ?? "");
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  document.head.innerHTML =
    '<link rel="icon" type="image/svg+xml" href="/empirevu-favicon.svg" /><link rel="icon" type="image/png" href="/empirevu-favicon.png" />';
  document.title = "EmpireVu";
  document.documentElement.removeAttribute("data-brand");
  auth.status = "unauthenticated";
  auth.session = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("signed out: Everdoer on every host", () => {
  it.each([
    ["app.crankleads.com", "done_for_you"],
    ["app.everdoer.com", "done_for_you"],
    ["app.empirevu.com", "standard"],
    ["localhost", "standard"],
  ])("%s → Everdoer sign-in (logo, title, favicon); product line %s", (host, line) => {
    withHost(host);
    renderApp(<SignInPage />, "/signin");
    const logo = screen.getByRole("img", { name: "Everdoer" });
    expect(logo).toHaveAttribute("src", "/brand/everdoer/everdoer-logo-on-dark.svg");
    expect(logo).toHaveAttribute("width", String(EVERDOER_BRAND.logoWidth));
    expect(logo).toHaveAttribute("height", String(EVERDOER_BRAND.logoHeight));
    expect(document.title).toBe("Everdoer");
    expect(iconHrefs().every((h) => h === "/favicon.svg")).toBe(true);
    expect(document.head.querySelector('link[rel="apple-touch-icon"]')).toHaveAttribute("href", "/apple-touch-icon.png");
    expect(document.documentElement.hasAttribute("data-brand")).toBe(false);
    expect(screen.getByTestId("product-line")).toHaveTextContent(line);
    expect(document.body.textContent ?? "").not.toMatch(OLD_NAMES);
  });
});

describe("signed in: Everdoer for every org; the product line follows the active org", () => {
  it("a done-for-you org: Everdoer sidebar, AI receptionist copy — on any host", () => {
    withHost("app.empirevu.com");
    auth.status = "authenticated";
    auth.session = {
      activeOrganizationId: "org-cl",
      organizations: [{ id: "org-cl", name: "Jane's Roofing", slug: "jr", membershipRole: "owner", platformBrand: "crankleads" }],
    };
    renderApp(<AppSidebar />);
    expect(screen.getByTestId("brand-name")).toHaveTextContent("Everdoer");
    expect(screen.getAllByRole("img", { name: "Everdoer" }).length).toBeGreaterThan(0);
    expect(screen.getByTestId("product-line")).toHaveTextContent("done_for_you");
    expect(screen.getByTestId("receptionist")).toHaveTextContent("Call with the AI receptionist");
    expect(document.title).toBe("Everdoer");
    expect(document.documentElement.hasAttribute("data-brand")).toBe(false);
    expect(document.body.textContent ?? "").not.toMatch(OLD_NAMES);
  });

  it("a house org (A1 etc.): Everdoer sidebar, still Marina — even on the done-for-you host", () => {
    withHost("app.crankleads.com");
    auth.status = "authenticated";
    auth.session = {
      activeOrganizationId: "org-a1",
      organizations: [{ id: "org-a1", name: "A1 Marine", slug: "a1", membershipRole: "owner", platformBrand: "empirevu" }],
    };
    renderApp(<AppSidebar />);
    expect(screen.getByTestId("brand-name")).toHaveTextContent("Everdoer");
    expect(screen.getByTestId("product-line")).toHaveTextContent("standard");
    expect(screen.getByTestId("receptionist")).toHaveTextContent("Call with Marina");
    expect(document.documentElement.hasAttribute("data-brand")).toBe(false);
    expect(document.body.textContent ?? "").not.toMatch(OLD_NAMES);
  });

  it("a Phase 3 platform_brand value is understood", () => {
    auth.status = "authenticated";
    auth.session = {
      activeOrganizationId: "org-x",
      organizations: [{ id: "org-x", name: "X", slug: "x", membershipRole: "owner", platformBrand: "done_for_you" }],
    };
    renderApp(<div />);
    expect(screen.getByTestId("product-line")).toHaveTextContent("done_for_you");
  });
});

describe("customer-facing pages", () => {
  it("get a neutral tab icon and no platform title or theme", () => {
    withHost("app.crankleads.com");
    renderApp(<div>form</div>, "/f/evpk_x");
    expect(iconHrefs().every((h) => h === "/brand/neutral-favicon.svg")).toBe(true);
    expect(document.title).not.toMatch(/Everdoer|EmpireVu|CrankLeads/);
    expect(document.documentElement.hasAttribute("data-brand")).toBe(false);
  });
});
