/**
 * BrandProvider — which platform brand (EmpireVu or CrankLeads) the signed-in person's OWN
 * app chrome shows: logo, product name in copy, tab title, favicon and theme
 * (docs/crankleads-branding.md; configs in src/lib/platform-brand.ts).
 *
 *  - Signed out (sign-in, sign-up, password reset): from the hostname — app.crankleads.com
 *    (and crankleads.localhost in dev) is CrankLeads, everything else EmpireVu.
 *  - Signed in: from the ACTIVE org's platform_brand (session context), so a person in both
 *    a house org and a CrankLeads org sees the brand of the org they're working in.
 *
 * Applies itself to the document: `data-brand` on <html> (index.css swaps the colour
 * tokens), the default tab title and the favicon. Customer-facing public pages
 * (/q, /i, /p, /v, /f, /book) are skipped — they brand from the company, never the platform.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";

import { useAuth } from "@/lib/auth-context";
import { brandForHost, platformBrand, PLATFORM_BRANDS, type PlatformBrand, type PlatformBrandKey } from "@/lib/platform-brand";

interface BrandContextValue {
  brand: PlatformBrand;
  /** Set by OrgProvider (BrandOrgSync) when the active org changes. */
  setActiveOrganizationId: (id: string) => void;
  setBrandOverride: (key: PlatformBrandKey | null) => void;
  setCustomerFavicon: (href: string | null) => void;
}

function hostBrand(): PlatformBrand {
  return brandForHost(typeof window === "undefined" ? "" : window.location.hostname);
}

const BrandContext = createContext<BrandContextValue | null>(null);

/** Customer-facing pages: branded from the company; the platform stays out of the tab. */
const CUSTOMER_PAGE = /^\/(q|i|p|v|f|book)\//;

/** Tab icon on a customer page whose company has no logo: neutral, never a platform mark. */
export const NEUTRAL_FAVICON_HREF = "/brand/neutral-favicon.svg";

export function BrandProvider({ children }: { children: ReactNode }) {
  const { status, session } = useAuth();
  const [activeOrganizationId, setActiveOrganizationId] = useState("");
  const [brandOverride, setBrandOverride] = useState<PlatformBrandKey | null>(null);
  const [customerFavicon, setCustomerFavicon] = useState<string | null>(null);
  const location = useLocation();

  const brand = useMemo(() => {
    if (brandOverride) return platformBrand(brandOverride);
    if (status === "authenticated" && session && session.organizations.length > 0) {
      const org =
        session.organizations.find((o) => o.id === activeOrganizationId) ??
        session.organizations.find((o) => o.id === session.activeOrganizationId) ??
        session.organizations[0];
      return platformBrand(org.platformBrand);
    }
    return hostBrand();
  }, [status, session, activeOrganizationId, brandOverride]);

  const customerPage = CUSTOMER_PAGE.test(location.pathname);
  useApplyBrandToDocument(brand, customerPage ? (customerFavicon ?? NEUTRAL_FAVICON_HREF) : null);

  const value = useMemo(
    () => ({ brand, setActiveOrganizationId, setBrandOverride, setCustomerFavicon }),
    [brand],
  );
  return <BrandContext.Provider value={value}>{children}</BrandContext.Provider>;
}

/** The current platform brand. Outside a BrandProvider: the hostname's brand. */
export function useBrand(): PlatformBrand {
  return useContext(BrandContext)?.brand ?? hostBrand();
}

/** Mounted inside OrgProvider: tells BrandProvider which org is active. */
export function BrandOrgSync({ organizationId }: { organizationId: string }) {
  const ctx = useContext(BrandContext);
  const setter = ctx?.setActiveOrganizationId;
  useEffect(() => {
    setter?.(organizationId);
  }, [setter, organizationId]);
  return null;
}

/**
 * Pin the brand while a page is mounted — the CrankLeads purchase welcome page is CrankLeads
 * even before the buyer has an account, whatever host it is served from.
 */
export function useBrandOverride(key: PlatformBrandKey | null): void {
  const setter = useContext(BrandContext)?.setBrandOverride;
  useEffect(() => {
    if (!setter || !key) return;
    setter(key);
    return () => setter(null);
  }, [setter, key]);
}

/**
 * A customer-facing page's tab icon: the company's logo when it has one; the neutral icon
 * otherwise (BrandProvider's default on those pages). Never a platform mark.
 */
export function useCustomerFavicon(href: string | null | undefined): void {
  const setter = useContext(BrandContext)?.setCustomerFavicon;
  useEffect(() => {
    if (!setter) return;
    setter(href || null);
    return () => setter(null);
  }, [setter, href]);
}

const MANAGED_ATTR = "data-platform-brand-icon";

function setIcons(href: string, type: string | null, touchHref: string | null): void {
  const head = document.head;
  // Every rel~=icon link points at the same icon: browsers pick among several, and a
  // leftover platform PNG would win on some of them.
  const icons = Array.from(head.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'));
  if (icons.length === 0) {
    const link = document.createElement("link");
    link.rel = "icon";
    head.appendChild(link);
    icons.push(link);
  }
  for (const link of icons) {
    link.setAttribute("href", href);
    if (type) link.setAttribute("type", type);
    else link.removeAttribute("type");
  }
  let touch = head.querySelector<HTMLLinkElement>(`link[rel="apple-touch-icon"][${MANAGED_ATTR}]`);
  if (!touch) {
    touch = document.createElement("link");
    touch.rel = "apple-touch-icon";
    touch.setAttribute(MANAGED_ATTR, "");
    head.appendChild(touch);
  }
  touch.href = touchHref ?? href;
}

function iconType(href: string): string | null {
  return /\.svg(\?|$)/i.test(href) ? "image/svg+xml" : /\.png(\?|$)/i.test(href) ? "image/png" : null;
}

/**
 * Brand the document. `customerIcon` is set on customer-facing pages: no platform theme,
 * title or icon there — the company's logo (or a neutral icon) in the tab instead, and the
 * page sets its own company-named title.
 */
function useApplyBrandToDocument(brand: PlatformBrand, customerIcon: string | null): void {
  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const platformTitles = Object.values(PLATFORM_BRANDS).map((b) => b.name);
    if (customerIcon) {
      root.removeAttribute("data-brand");
      setIcons(customerIcon, iconType(customerIcon), null);
      if (platformTitles.includes(document.title)) document.title = "";
      return;
    }
    if (brand.key === "empirevu") root.removeAttribute("data-brand");
    else root.setAttribute("data-brand", brand.key);
    setIcons(brand.faviconHref, brand.faviconType, brand.appleTouchIconHref);
    // Only replace a platform default title — a page that set its own keeps it.
    if (!document.title || platformTitles.includes(document.title)) document.title = brand.name;
  }, [brand, customerIcon]);
}
