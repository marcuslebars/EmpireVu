/**
 * POST …/imports/start-reminders — ask the owner (approval chase_imported_balances, texted like any
 * other approval) to let reminders start on the imported balances on hold. Nothing is released
 * here: the owner's Y does that. Owner/admin.
 */
import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { createChaseApproval, loadHeldBalances, pendingChase } from "@/server/services/staff/importer/approvals";
import { defaultImporterDeps } from "@/server/services/staff/importer/deps";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { importGuard, type ImportRouteContext } from "../guard";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, context: ImportRouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const { company } = await importGuard(context, true);
    const admin = createSupabaseAdminClient();
    const pending = await pendingChase(admin, company.companyId);
    if (pending) return NextResponse.json({ data: { code: pending.short_code, created: false } });
    const held = await loadHeldBalances(admin, company);
    const chase = await createChaseApproval(admin, company, held, defaultImporterDeps);
    return NextResponse.json({ data: { code: chase?.shortCode ?? null, created: Boolean(chase) } });
  });
}
