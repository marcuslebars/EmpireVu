import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { UserFacingError } from "@/server/errors";
import { guardTaxClerk } from "@/server/services/staff/tax-clerk/route-guard";
import { getTaxClerkView, updateTaxClerk } from "@/server/services/staff/tax-clerk/view";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; companyId: string };
}

const patchSchema = z
  .object({
    receipts: z.object({ enabled: z.boolean().optional() }).strict().optional(),
    hst: z
      .object({
        registrant: z.boolean().nullable().optional(),
        frequency: z.enum(["monthly", "quarterly", "annual"]).optional(),
        fiscalYearEndMonth: z.number().int().min(1).max(12).optional(),
        filer: z.enum(["individual", "corporation"]).optional(),
        reminders: z.boolean().optional(),
        accountantEmail: z.union([z.literal(""), z.null(), z.string().trim().email().max(254)]).optional(),
      })
      .strict()
      .optional(),
    nudges: z.object({ weekly: z.boolean().optional(), tip: z.boolean().optional() }).strict().optional(),
  })
  .strict();

/** Settings → AI front desk → Receipts & HST. */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const { organizationId, companyId, canManage } = await guardTaxClerk(context.params, false);
    const data = await getTaxClerkView(createSupabaseAdminClient(), organizationId, companyId, { manage: canManage });
    if (!data) throw new UserFacingError("Company not found.", { status: 404 });
    return NextResponse.json({ data });
  });
}

/** Owner/admin: merge ONLY ai_settings.tax_clerk. */
export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const { organizationId, companyId } = await guardTaxClerk(context.params, true);
    const patch = await parseJsonBody(request, patchSchema);
    const data = await updateTaxClerk(createSupabaseAdminClient(), organizationId, companyId, patch);
    if (!data) throw new UserFacingError("Company not found.", { status: 404 });
    return NextResponse.json({ data });
  });
}
