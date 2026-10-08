// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION (service role): the public generated-site page (/s/:slug and the pages
// host). No session. The company is resolved FROM THE SLUG ROW ONLY, only status 'published'
// renders, and the page shows only what the site's content snapshot holds plus the company's
// active form key (publishable by design) and its booking link when online booking is on.
// docs/done-for-you.md → "Generated sites".
// ─────────────────────────────────────────────────────────────────────────────
import { createHash } from "node:crypto";

import type { Tables } from "@/server/db/database.types";
import type { AdminClient } from "@/server/services/crankleads/purchases";
import { bookingPageUrl } from "@/server/services/scheduling/urls";
import { parseOnlineBookingSettings } from "@/server/services/scheduling/rules";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

import { isValidSlug, parseSiteContent, type SiteContent } from "./site-content";
import { renderSitePage, type SiteRenderOptions } from "./site-render";
import { siteUrl } from "./site-url";

export const CRANKLEADS_SITE_CREDIT_URL = "https://crankleads.com";

export interface RenderedSite {
  html: string;
  etag: string;
}

export function turnstileSiteKey(): string | null {
  return process.env.TURNSTILE_SITE_KEY?.trim() || process.env.VITE_TURNSTILE_SITE_KEY?.trim() || null;
}

/** Live render inputs for one site's company: active form key + booking link. */
export async function siteRuntime(
  admin: AdminClient,
  site: Pick<Tables<"company_sites">, "organization_id" | "company_id" | "slug">,
  content: SiteContent,
): Promise<SiteRenderOptions> {
  const [{ data: keys }, { data: company }] = await Promise.all([
    admin
      .from("public_form_keys")
      .select("public_key, form_type")
      .eq("organization_id", site.organization_id)
      .eq("company_id", site.company_id)
      .eq("active", true)
      .order("created_at", { ascending: true }),
    admin
      .from("companies")
      .select("id, online_booking_settings, quote_public_base_url")
      .eq("organization_id", site.organization_id)
      .eq("id", site.company_id)
      .maybeSingle(),
  ]);
  const keyRows = (keys ?? []) as Array<{ public_key: string; form_type: string }>;
  const formKey = (keyRows.find((k) => k.form_type === "quote") ?? keyRows[0])?.public_key ?? null;
  const companyRow = company as Pick<Tables<"companies">, "id" | "online_booking_settings" | "quote_public_base_url"> | null;
  const bookingUrl = companyRow && parseOnlineBookingSettings(companyRow.online_booking_settings).enabled ? bookingPageUrl(companyRow) : null;
  return {
    url: siteUrl(site.slug, content.facts.brand),
    formKey,
    bookingUrl,
    turnstileSiteKey: turnstileSiteKey(),
    creditUrl: content.facts.brand === "crankleads" ? CRANKLEADS_SITE_CREDIT_URL : null,
  };
}

/** The published page for a slug, or null (unknown, draft, unpublished, unreadable content → 404). */
export async function loadPublishedSitePage(slug: string, admin: AdminClient = createSupabaseAdminClient()): Promise<RenderedSite | null> {
  const s = (slug ?? "").trim().toLowerCase();
  if (!isValidSlug(s)) return null;
  const { data, error } = await admin
    .from("company_sites")
    .select("id, organization_id, company_id, slug, status, content, updated_at")
    .eq("slug", s)
    .maybeSingle();
  if (error) throw new Error(`site read failed: ${error.message}`);
  const site = data as Pick<Tables<"company_sites">, "id" | "organization_id" | "company_id" | "slug" | "status" | "content" | "updated_at"> | null;
  if (!site || site.status !== "published") return null;
  const content = parseSiteContent(site.content);
  if (!content) return null;
  const options = await siteRuntime(admin, site, content);
  const html = renderSitePage(content, options);
  const etag = `"${createHash("sha1").update(html).digest("base64url").slice(0, 27)}"`;
  return { html, etag };
}
