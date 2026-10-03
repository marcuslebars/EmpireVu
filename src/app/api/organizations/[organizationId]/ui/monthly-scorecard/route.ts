import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { AuthorizationError, requireOrganizationContext, ValidationError } from "@/server/organizations/context";
import {
  getScorecardView,
  MAX_OPERATOR_NOTE_CHARS,
  setOperatorNote,
  updateScorecardSettings,
} from "@/server/services/monthly-scorecard/scorecard";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    organizationId: string;
  };
}

const updateSchema = z.object({
  companyId: z.string().uuid(),
  /** YYYY-MM the operator note applies to. Required with operatorNote. */
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month must be YYYY-MM")
    .optional(),
  /** Free-text "what we're tuning next" note; null or "" clears it. */
  operatorNote: z.string().max(MAX_OPERATOR_NOTE_CHARS).nullable().optional(),
  /** Opt the company in/out of the monthly scorecard email. */
  enabled: z.boolean().optional(),
});

/** Monthly results for one company: this month so far + last month (any org member). */
export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const companyId = new URL(request.url).searchParams.get("companyId");
    if (!companyId) {
      return NextResponse.json({ error: "companyId is required" }, { status: 400 });
    }

    const data = await getScorecardView(
      { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase },
      companyId,
    );
    return NextResponse.json({ data });
  });
}

/** Operator note + opt-out — owners/admins only (RLS enforces the note write again). */
export async function PUT(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    if (organization.membership.role !== "owner" && organization.membership.role !== "admin") {
      throw new AuthorizationError("Only organization owners and admins can edit the monthly scorecard.");
    }
    const body = await parseJsonBody(request, updateSchema);
    const serviceContext = {
      actorProfileId: organization.user.id,
      organizationId: organization.organizationId,
      supabase,
    };

    const data: { operatorNote?: string | null; settings?: { enabled: boolean } } = {};
    if (body.operatorNote !== undefined) {
      if (!body.month) throw new ValidationError("month is required to set an operator note.");
      data.operatorNote = await setOperatorNote(serviceContext, body.companyId, body.month, body.operatorNote);
    }
    if (body.enabled !== undefined) {
      data.settings = await updateScorecardSettings(serviceContext, body.companyId, { enabled: body.enabled });
    }
    return NextResponse.json({ data });
  });
}
