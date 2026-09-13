import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { ValidationError, requireOrganizationContext } from "@/server/organizations/context";
import { getQuotesConfig } from "@/server/services/quotes/config";
import { CatalogNotConfiguredError, loadCatalog } from "@/server/services/quotes/catalog-repo";
import { assertCompanyInOrganization } from "@/server/services/shared";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string };
}

/**
 * A company's price list for building a quote: services with their pricing type and the
 * inputs each one needs, plus bundles and variant surcharges. Prices stay server-side —
 * the app sends selections and gets totals back from /quotes/preview.
 */
export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    if (!getQuotesConfig().enabled) return NextResponse.json({ error: "Quotes are not enabled." }, { status: 404 });

    const supabase = createSupabaseServerClient();
    const org = await requireOrganizationContext(supabase, context.params.organizationId);
    const companyId = new URL(request.url).searchParams.get("companyId");
    if (!companyId) throw new ValidationError("companyId is required.");
    await assertCompanyInOrganization({ organizationId: org.organizationId, actorProfileId: org.user.id, supabase }, companyId);

    try {
      const catalog = await loadCatalog(companyId);
      return NextResponse.json({
        data: {
          configured: true,
          items: Object.values(catalog.items).map((item) => ({
            serviceKey: item.serviceKey,
            label: item.label,
            description: item.description ?? null,
            pricingType: item.pricingType,
            rateCents: item.rateCents,
            minimumCents: item.minimumCents,
            unitLabel: item.unitLabel ?? null,
            maxQuantity: item.maxQuantity ?? null,
            maxMeasure: item.maxMeasure ?? null,
            surchargeEligible: item.surchargeEligible,
          })),
          bundles: Object.values(catalog.bundles),
          surcharges: Object.values(catalog.surcharges),
        },
      });
    } catch (error) {
      if (error instanceof CatalogNotConfiguredError) {
        return NextResponse.json({ data: { configured: false, items: [], bundles: [], surcharges: [] } });
      }
      throw error;
    }
  });
}
