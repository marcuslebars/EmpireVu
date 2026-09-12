import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import {
  getAttributionSummary,
  listAttribution,
  monthRangeInTimeZone,
  resolveCompanyTimeZone,
} from "@/server/services/attribution";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    organizationId: string;
  };
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const url = new URL(request.url);

    const serviceContext = {
      actorProfileId: organization.user.id,
      organizationId: organization.organizationId,
      supabase,
    };

    const companyId = url.searchParams.get("companyId");
    const fromParam = url.searchParams.get("from");
    const toParam = url.searchParams.get("to");
    const includeRows = url.searchParams.get("rows") === "1";

    // Default window = the current calendar month in the company's timezone (Amendment 4:
    // companies.timezone, falling back to BUSINESS_TIMEZONE then America/Toronto).
    let range: { from: string; to: string };
    if (fromParam && toParam) {
      range = { from: fromParam, to: toParam };
    } else {
      const timeZone = await resolveCompanyTimeZone(serviceContext, companyId);
      range = monthRangeInTimeZone(timeZone, Date.now());
    }

    const summary = await getAttributionSummary(serviceContext, {
      companyId,
      from: range.from,
      to: range.to,
    });

    const rows = includeRows
      ? await listAttribution(serviceContext, { companyId, from: range.from, to: range.to })
      : undefined;

    return NextResponse.json({ data: { range, summary, rows } });
  });
}
