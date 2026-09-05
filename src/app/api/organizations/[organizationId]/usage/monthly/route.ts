import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { orgLimit } from "@/server/services/billing/gating";
import { getMonthlyUsage } from "@/server/services/usage";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    organizationId: string;
  };
}

/**
 * This-month usage summary for the billing settings panel (Task 6). Member-scoped read
 * of usage_monthly_v (RLS), plus the plan's voice-minutes cap. `?month=YYYY-MM` overrides
 * the current (America/Toronto) month.
 */
export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const month = new URL(request.url).searchParams.get("month") ?? undefined;

    const rows = await getMonthlyUsage(supabase, organization.organizationId, month);
    const sumQuantity = (kind: string) =>
      rows.filter((row) => row.kind === kind).reduce((total, row) => total + row.quantity, 0);
    const sumCost = (kinds: string[]) =>
      rows.filter((row) => kinds.includes(row.kind)).reduce((total, row) => total + row.costCents, 0);

    const voiceMinutes = sumQuantity("voice_minutes");
    const voiceMinutesCap = await orgLimit(supabase, organization.organizationId, "marina_reception");

    return NextResponse.json({
      data: {
        voiceMinutes: Math.round(voiceMinutes),
        voiceMinutesCap,
        voiceOverageMinutes:
          voiceMinutesCap != null ? Math.max(0, Math.round(voiceMinutes - voiceMinutesCap)) : 0,
        smsSent: Math.round(sumQuantity("sms_sent")),
        smsReceived: Math.round(sumQuantity("sms_received")),
        emailsSent: Math.round(sumQuantity("email_sent")),
        aiCostCents: sumCost(["ai_input_tokens", "ai_output_tokens", "ai_cache_read_tokens"]),
        totalCostCents: rows.reduce((total, row) => total + row.costCents, 0),
      },
    });
  });
}
