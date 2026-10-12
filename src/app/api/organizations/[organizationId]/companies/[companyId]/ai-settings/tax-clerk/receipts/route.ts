import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { UserFacingError } from "@/server/errors";
import { EXPENSE_CATEGORIES } from "@/server/services/expenses/rules";
import { finishReceipt, getTaxClerkView, type FinishInput } from "@/server/services/staff/tax-clerk/view";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { guardTaxClerk } from "@/server/services/staff/tax-clerk/route-guard";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; companyId: string };
}

const bodySchema = z
  .object({
    id: z.string().uuid(),
    action: z.enum(["file", "discard"]),
    amountCents: z.number().int().min(1).max(100_000_000).optional(),
    taxCents: z.number().int().min(0).max(100_000_000).optional(),
    spentOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    category: z.enum(EXPENSE_CATEGORIES).optional(),
  })
  .strict();

/** Owner/admin: file a texted receipt that was missing its total, or throw it away. */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const { organizationId, companyId, profileId } = await guardTaxClerk(context.params, true);
    const body = await parseJsonBody(request, bodySchema);
    const admin = createSupabaseAdminClient();
    const result = await finishReceipt(admin, { organizationId, companyId }, profileId, body as FinishInput);
    if (result.status === "not_found") throw new UserFacingError(result.message, { status: 404 });
    if (result.status === "invalid") throw new UserFacingError(result.message, { status: 400 });
    const data = await getTaxClerkView(admin, organizationId, companyId, { manage: true });
    return NextResponse.json({ data, result });
  });
}
