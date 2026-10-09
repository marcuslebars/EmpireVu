import { NextResponse } from "next/server";
import { z } from "zod";

import { parseJsonBody } from "@/server/api/route";
import { weeklyReportSettingsRoute } from "@/server/api/weekly-report-route";
import { loadOrganizationBrand } from "@/server/services/platform-brand";
import { WEEKLY_REPORT_CHANNELS } from "@/server/services/weekly-report/settings";
import { getWeeklyReportSettingsView, updateWeeklyReportSettings } from "@/server/services/weekly-report/view";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; companyId: string };
}

const patchSchema = z
  .object({
    enabled: z.boolean().optional(),
    channels: z.array(z.enum(WEEKLY_REPORT_CHANNELS)).min(1, "Pick at least one way to get the report.").optional(),
  })
  .strict();

/** Current weekly report settings (any org member; read on the caller's RLS client). */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  const { organizationId, companyId } = context.params;
  return weeklyReportSettingsRoute(
    organizationId,
    companyId,
    async ({ ctx, organization }) => {
      const role = organization.membership.role;
      const data = await getWeeklyReportSettingsView(ctx, companyId);
      return NextResponse.json({ data: { ...data, canManage: role === "owner" || role === "admin" } });
    },
    { manage: false },
  );
}

/**
 * Settings → AI front desk → Weekly report (owners/admins). Merges ONLY
 * companies.ai_settings.weekly_report; ai_settings isn't client-writable, so the write uses
 * the service role after the org-admin + company-in-org checks.
 */
export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  const { organizationId, companyId } = context.params;
  return weeklyReportSettingsRoute(organizationId, companyId, async ({ ctx }) => {
    const body = await parseJsonBody(request, patchSchema);
    const brand = await loadOrganizationBrand(ctx.supabase, ctx.organizationId);
    const settings = await updateWeeklyReportSettings(
      createSupabaseAdminClient(),
      ctx.organizationId,
      companyId,
      body,
      brand.key === "crankleads",
    );
    const view = await getWeeklyReportSettingsView(ctx, companyId);
    return NextResponse.json({ data: { ...view, enabled: settings.enabled, channels: settings.channels, canManage: true } });
  });
}
