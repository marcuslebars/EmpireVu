import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { draftCatalogFromWebsite } from "@/server/ai/catalog-parser";
import { recordAiUsageSafe } from "@/server/services/usage";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string };
}

const parseBodySchema = z.object({ url: z.string().min(3).max(500) });

/**
 * "Paste your website URL" → the server fetches the page and asks Claude for draft catalog
 * items (proposals only; nothing is inserted here). AI token usage is metered.
 */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const body = await parseJsonBody(request, parseBodySchema);

    const { drafts, usage, sourceChars } = await draftCatalogFromWebsite(body.url);

    await recordAiUsageSafe({
      organizationId: organization.organizationId,
      companyId: null,
      model: usage.model,
      responseId: usage.responseId,
      usage: usage.usage,
    });

    return NextResponse.json({ data: { drafts, sourceChars } });
  });
}
