import { NextResponse } from "next/server";
import { z } from "zod";

import type { Tables } from "@/server/db/database.types";
import { siteRoute } from "@/server/api/site-route";
import { effectiveCopy, parseSiteContent, SITE_MODES } from "@/server/services/dfy/site-content";
import { generateSite, setSiteStatus, updateSiteEdits } from "@/server/services/dfy/site-generator";
import { siteUrl } from "@/server/services/dfy/site-url";
import { loadOrganizationBrand } from "@/server/services/platform-brand";
import type { TenantServiceContext } from "@/server/services/shared";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; companyId: string };
}

/** What Settings → Your website shows. */
async function siteView(ctx: TenantServiceContext, companyId: string, canManage: boolean) {
  const [{ data: siteData, error }, { data: companyData }] = await Promise.all([
    ctx.supabase.from("company_sites").select("*").eq("organization_id", ctx.organizationId).eq("company_id", companyId).maybeSingle(),
    ctx.supabase.from("companies").select("id, name, website").eq("organization_id", ctx.organizationId).eq("id", companyId).maybeSingle(),
  ]);
  if (error) throw error;
  const site = siteData as Tables<"company_sites"> | null;
  const company = companyData as Pick<Tables<"companies">, "id" | "name" | "website"> | null;
  const base = { companyId, companyName: company?.name ?? "", hasWebsite: Boolean(company?.website?.trim()), canManage };
  if (!site) return { ...base, site: null };
  const brand = await loadOrganizationBrand(ctx.supabase, ctx.organizationId);
  const content = parseSiteContent(site.content);
  const copy = content ? effectiveCopy(content) : null;
  return {
    ...base,
    site: {
      slug: site.slug,
      status: site.status,
      mode: site.mode,
      url: siteUrl(site.slug, brand.key),
      previewUrl: `/api/organizations/${ctx.organizationId}/companies/${companyId}/site/preview`,
      generatedAt: site.generated_at,
      publishedAt: site.published_at,
      copySource: content?.copySource ?? null,
      headline: copy?.headline ?? "",
      subhead: copy?.subhead ?? "",
      about: copy?.about ?? "",
      generated: content ? { headline: content.copy.headline, subhead: content.copy.subhead, about: content.copy.about } : null,
      edited: {
        headline: Boolean(content?.edits.headline),
        subhead: Boolean(content?.edits.subhead),
        about: Boolean(content?.edits.about),
      },
      showPrices: content?.settings.showPrices ?? true,
      servicesCount: content?.facts.services.length ?? 0,
      pricedCount: content?.facts.services.filter((s) => s.priceText).length ?? 0,
      factsUsed: content?.factsUsed ?? [],
    },
  };
}

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  const { organizationId, companyId } = context.params;
  return siteRoute(organizationId, companyId, async ({ ctx, canManage }) =>
    NextResponse.json({ data: await siteView(ctx, companyId, canManage) }),
  );
}

const patchSchema = z
  .object({
    headline: z.string().max(90).nullable().optional(),
    subhead: z.string().max(220).nullable().optional(),
    about: z.string().max(1200).nullable().optional(),
    showPrices: z.boolean().optional(),
    mode: z.enum(SITE_MODES).optional(),
  })
  .strict();

/** Owner edits (owners/admins). An empty headline/subhead/about goes back to the generated text. */
export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  const { organizationId, companyId } = context.params;
  return siteRoute(
    organizationId,
    companyId,
    async ({ ctx, canManage }) => {
      const body = patchSchema.parse(await request.json().catch(() => ({})));
      await updateSiteEdits(createSupabaseAdminClient(), companyId, body);
      return NextResponse.json({ data: await siteView(ctx, companyId, canManage) });
    },
    { manage: true },
  );
}

const actionSchema = z.object({
  action: z.enum(["generate", "regenerate", "publish", "unpublish"]),
  /** generate/regenerate only: publish in the same step. */
  publish: z.boolean().optional(),
});

/** Generate / regenerate / publish / unpublish (owners/admins). */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  const { organizationId, companyId } = context.params;
  return siteRoute(
    organizationId,
    companyId,
    async ({ ctx, canManage }) => {
      const body = actionSchema.parse(await request.json().catch(() => ({})));
      const admin = createSupabaseAdminClient();
      if (body.action === "generate" || body.action === "regenerate") {
        await generateSite(admin, companyId, { publish: body.publish === true });
        if (body.publish) await setSiteStatus(admin, companyId, "published", { markOwnerNotified: true });
      } else if (body.action === "publish") {
        const { data: existing } = await ctx.supabase.from("company_sites").select("id").eq("organization_id", organizationId).eq("company_id", companyId).maybeSingle();
        if (!existing) await generateSite(admin, companyId, { publish: true });
        await setSiteStatus(admin, companyId, "published", { markOwnerNotified: true });
      } else {
        await setSiteStatus(admin, companyId, "unpublished");
      }
      return NextResponse.json({ data: await siteView(ctx, companyId, canManage) });
    },
    { manage: true },
  );
}
