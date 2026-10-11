import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { UserFacingError } from "@/server/errors";
import { AuthorizationError, requireOrganizationContext } from "@/server/organizations/context";
import { assertCompanyInOrganization, type TenantServiceContext } from "@/server/services/shared";
import { lockPeriodFromApp, unlockPeriod } from "@/server/services/staff/recruiter/payroll";
import { getRecruiterView } from "@/server/services/staff/recruiter/view";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; companyId: string; periodId: string };
}

const bodySchema = z
  .object({
    action: z.enum(["lock", "unlock"]),
    reason: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

/**
 * Owner/admin: lock a pay period (and email the CSV) or unlock it so its hours can be edited.
 * Both are logged in pay_period_events with who did it (docs/ai-staff.md → "Hiring & payroll").
 */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const role = organization.membership.role;
    if (role !== "owner" && role !== "admin") throw new AuthorizationError("Only owners and admins can lock or unlock payroll.");
    const ctx: TenantServiceContext = { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase };
    await assertCompanyInOrganization(ctx, context.params.companyId);
    if (!/^[0-9a-f-]{36}$/i.test(context.params.periodId)) throw new UserFacingError("Pay period not found.", { status: 404 });
    const body = await parseJsonBody(request, bodySchema);
    const admin = createSupabaseAdminClient();
    const scope = { organizationId: organization.organizationId, companyId: context.params.companyId };
    if (body.action === "unlock") {
      const period = await unlockPeriod(admin, scope, context.params.periodId, { profileId: organization.user.id, reason: body.reason?.trim() || null });
      if (!period) throw new UserFacingError("Pay period not found.", { status: 404 });
    } else {
      const { period, result } = await lockPeriodFromApp(admin, scope, context.params.periodId, organization.user.id);
      if (!period || !result) throw new UserFacingError("Pay period not found.", { status: 404 });
      if (result.status === "not_lockable") throw new UserFacingError("That pay period can't be locked.", { status: 409 });
    }
    const data = await getRecruiterView(admin, scope.organizationId, scope.companyId, { manager: true });
    return NextResponse.json({ data });
  });
}
