import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import {
  listCompanyVoiceProfiles,
  upsertCompanyVoiceProfile,
} from "@/server/services/company-voice-profiles";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string };
}

const upsertSchema = z.object({
  companyId: z.string().uuid(),
  retellOutboundAgentId: z.string().max(200).nullish(),
  fromNumber: z.string().max(32).nullish(),
  brandLabel: z.string().max(200).nullish(),
  dynamicVariables: z.record(z.string(), z.string()).optional(),
  active: z.boolean().optional(),
});

/** Set (create or update) a company's voice profile — the Retell agent + brand context. */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const org = await requireOrganizationContext(supabase, context.params.organizationId);
    const parsed = upsertSchema.parse(await request.json().catch(() => ({})));

    const profile = await upsertCompanyVoiceProfile(
      { organizationId: org.organizationId, actorProfileId: org.user.id, supabase },
      {
        companyId: parsed.companyId,
        retellOutboundAgentId: parsed.retellOutboundAgentId ?? null,
        fromNumber: parsed.fromNumber ?? null,
        brandLabel: parsed.brandLabel ?? null,
        dynamicVariables: parsed.dynamicVariables,
        active: parsed.active,
      },
    );
    return NextResponse.json({ data: profile });
  });
}

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const org = await requireOrganizationContext(supabase, context.params.organizationId);
    const profiles = await listCompanyVoiceProfiles({
      organizationId: org.organizationId,
      actorProfileId: org.user.id,
      supabase,
    });
    return NextResponse.json({ data: profiles });
  });
}
