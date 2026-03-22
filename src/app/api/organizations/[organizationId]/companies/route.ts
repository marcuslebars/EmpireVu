import { NextResponse } from "next/server";

import { handleRoute, parseJsonBody, parseLimit } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import {
  createCompany,
  createCompanyInputSchema,
  listCompanies,
} from "@/server/services/companies";
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

    const data = await listCompanies(
      {
        actorProfileId: organization.user.id,
        organizationId: organization.organizationId,
        supabase,
      },
      {
        limit: parseLimit(url.searchParams.get("limit")),
        stage: url.searchParams.get("stage") as "prospect" | "active" | "paused" | "archived" | null,
      },
    );

    return NextResponse.json({ data });
  });
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const input = await parseJsonBody(request, createCompanyInputSchema);

    const data = await createCompany(
      {
        actorProfileId: organization.user.id,
        organizationId: organization.organizationId,
        supabase,
      },
      input,
    );

    return NextResponse.json({ data }, { status: 201 });
  });
}