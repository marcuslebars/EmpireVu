import { NextResponse } from "next/server";

import { assertCanManagePacks } from "@/server/organizations/admin";
import { handleRoute, parseJsonBody } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { catalogPriceUpdateSchema, updateCatalogItemPrices } from "@/server/services/quotes/catalog-items";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string };
}

/** Enter prices on catalog items a pack created price-less. A positive price switches the item on. */
export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    assertCanManagePacks(organization);
    const body = await parseJsonBody(request, catalogPriceUpdateSchema);

    const items = await updateCatalogItemPrices(
      { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase },
      body,
    );
    return NextResponse.json({ data: { updated: items.length } });
  });
}
