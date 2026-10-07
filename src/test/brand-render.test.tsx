/**
 * BrandProvider (docs/crankleads-branding.md): signed out, the hostname picks the brand;
 * signed in, the active org's platform_brand does. A CrankLeads org's sidebar and sign-in
 * page show CrankLeads (logo, favicon, theme) and never "EmpireVu".
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
import { PLATFORM_BRANDS } from "@/lib/platform-brand";

function withHost(hostname: string) {
  vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, hostname } as Location);
}

function Probe() {
  return <span data-testid="brand-name">{useBrand().name}</span>;
}

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

describe("signed out: brand from the hostname", () => {
  it("app.crankleads.com → CrankLeads sign-in (logo, title, favicon, theme)", () => {
    withHost("app.crankleads.com");
    renderApp(<SignInPage />, "/signin");
    const logo = screen.getByRole("img", { name: "CrankLeads" });
    expect(logo).toHaveAttribute("src", PLATFORM_BRANDS.crankleads.logoSrc);
    expect(document.title).toBe("CrankLeads");
    expect(iconHrefs().every((h) => h.startsWith("/brand/crankleads-favicon"))).toBe(true);
    expect(document.documentElement.getAttribute("data-brand")).toBe("crankleads");
    expect(document.body.textContent ?? "").not.toMatch(/EmpireVu/);
  });

  it("any other host → EmpireVu sign-in (unchanged)", () => {
    withHost("app.empirevu.com");
    renderApp(<SignInPage />, "/signin");
    expect(screen.getByRole("img", { name: "EmpireVu" })).toHaveAttribute("src", "/empirevu-logo.png");
    expect(document.title).toBe("EmpireVu");
    expect(iconHrefs()[0]).toBe("/empirevu-favicon.svg");
    expect(document.documentElement.hasAttribute("data-brand")).toBe(false);
  });
});

describe("signed in: brand from the active org", () => {
  it("a CrankLeads org's sidebar shows CrankLeads — even on the EmpireVu host", () => {
    withHost("app.empirevu.com");
    auth.status = "authenticated";
    auth.session = {
      activeOrganizationId: "org-cl",
      organizations: [{ id: "org-cl", name: "Jane's Roofing", slug: "jr", membershipRole: "owner", platformBrand: "crankleads" }],
    };
    renderApp(<AppSidebar />);
    expect(screen.getByTestId("brand-name")).toHaveTextContent("CrankLeads");
    const logos = screen.getAllByRole("img", { name: "CrankLeads" });
    expect(logos.length).toBeGreaterThan(0);
    expect(screen.queryAllByRole("img", { name: "EmpireVu" })).toHaveLength(0);
    expect(document.title).toBe("CrankLeads");
    expect(document.documentElement.getAttribute("data-brand")).toBe("crankleads");
  });

  it("a house org stays EmpireVu, even on the CrankLeads host", () => {
    withHost("app.crankleads.com");
    auth.status = "authenticated";
    auth.session = {
      activeOrganizationId: "org-a1",
      organizations: [{ id: "org-a1", name: "A1 Marine", slug: "a1", membershipRole: "owner", platformBrand: "empirevu" }],
    };
    renderApp(<AppSidebar />);
    expect(screen.getByTestId("brand-name")).toHaveTextContent("EmpireVu");
    expect(document.documentElement.hasAttribute("data-brand")).toBe(false);
  });
});

describe("customer-facing pages", () => {
  it("get a neutral tab icon and no platform title or theme", () => {
    withHost("app.crankleads.com");
    renderApp(<div>form</div>, "/f/evpk_x");
    expect(iconHrefs().every((h) => h === "/brand/neutral-favicon.svg")).toBe(true);
    expect(document.title).not.toMatch(/EmpireVu|CrankLeads/);
    expect(document.documentElement.hasAttribute("data-brand")).toBe(false);
  });
});
