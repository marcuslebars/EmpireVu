import { NextResponse } from "next/server";

import { weeklyReportSettingsRoute } from "@/server/api/weekly-report-route";
import { sendTestWeeklyReport } from "@/server/services/weekly-report/send";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; companyId: string };
}

/**
 * "Send a test to me" (owners/admins): last week's report, emailed to the person clicking
 * (and texted to the owner's cell on file when the text channel is on). Doesn't use up the
 * week — the real Monday send still goes out.
 */
export async function POST(_request: Request, context: RouteContext): Promise<NextResponse> {
  const { organizationId, companyId } = context.params;
  return weeklyReportSettingsRoute(organizationId, companyId, async ({ ctx, organization }) => {
    const toEmail = organization.profile?.email ?? organization.user.email ?? null;
    const data = await sendTestWeeklyReport(createSupabaseAdminClient(), {
      organizationId: ctx.organizationId,
      companyId,
      toEmail,
    });
    return NextResponse.json({ data });
  });
}
