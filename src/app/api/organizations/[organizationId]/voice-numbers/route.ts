import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { AuthorizationError, requireOrganizationContext } from "@/server/organizations/context";
import { createVoiceNumber, listVoiceNumbers } from "@/server/services/voice-numbers";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string };
}

const createInputSchema = z.object({
  companyId: z.string().uuid(),
  phone: z.string().min(1).max(40),
  provider: z.enum(["retell", "telnyx", "twilio"]),
  mode: z.enum(["ai_receptionist", "missed_call_catcher", "sms_only"]).optional(),
  providerAgentId: z.string().max(200).nullable().optional(),
  brandLabel: z.string().max(120).nullable().optional(),
});

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const data = await listVoiceNumbers({
      actorProfileId: organization.user.id,
      organizationId: organization.organizationId,
      supabase,
    });
    return NextResponse.json({ data });
  });
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    if (!["owner", "admin"].includes(organization.membership.role)) {
      throw new AuthorizationError("Admin access is required to add voice numbers.");
    }
    const input = await parseJsonBody(request, createInputSchema);

    const data = await createVoiceNumber(
      { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase },
      {
        companyId: input.companyId,
        phone: input.phone,
        provider: input.provider,
        providerAgentId: input.providerAgentId ?? null,
        brandLabel: input.brandLabel ?? null,
        mode: input.mode,
      },
    );
    return NextResponse.json({ data });
  });
}
