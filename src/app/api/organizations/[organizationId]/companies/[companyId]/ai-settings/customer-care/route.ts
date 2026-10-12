import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { UserFacingError } from "@/server/errors";
import { AuthorizationError, requireOrganizationContext } from "@/server/organizations/context";
import { assertCompanyInOrganization, type TenantServiceContext } from "@/server/services/shared";
import { getCustomerCareView, removeEquipment, type EquipmentInput, resolveCaseById, saveEquipment, saveWarrantyTerm, updateCustomerCareSettings } from "@/server/services/staff/customer-care/view";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; companyId: string };
}

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const patchSchema = z
  .object({
    enabled: z.boolean().optional(),
    checkins: z
      .object({
        enabled: z.boolean().optional(),
        time: z.string().regex(/^((09|1[0-8]):[0-5]\d|19:00)$/).optional(),
        delayDays: z.number().int().min(1).max(7).optional(),
        minJobCents: z.number().int().min(0).max(100_000_000).optional(),
      })
      .strict()
      .optional(),
    warranty: z
      .object({
        months: z.number().int().min(0).max(600).optional(),
        terms: z.string().max(500).nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save_term"), catalogItemId: z.string().uuid(), months: z.number().int().min(0).max(600).nullable(), terms: z.string().max(500).nullable().optional() }).strict(),
  z
    .object({
      action: z.literal("save_equipment"),
      equipment: z
        .object({
          customer: z.string().min(2).max(120),
          make: z.string().max(80).nullable().optional(),
          model: z.string().max(80).nullable().optional(),
          serial: z.string().max(80).nullable().optional(),
          installedOn: ymd.nullable().optional(),
          warrantyEnds: ymd.nullable().optional(),
          notes: z.string().max(500).nullable().optional(),
        })
        .strict(),
    })
    .strict(),
  z.object({ action: z.literal("remove_equipment"), equipmentId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("resolve_case"), caseId: z.string().uuid(), outcome: z.enum(["resolved", "closed"]) }).strict(),
]);

async function guard(context: RouteContext, manage: boolean): Promise<{ organizationId: string; companyId: string; manager: boolean }> {
  const supabase = createSupabaseServerClient();
  const organization = await requireOrganizationContext(supabase, context.params.organizationId);
  const role = organization.membership.role;
  const manager = role === "owner" || role === "admin";
  if (manage && !manager) throw new AuthorizationError("Only owners and admins can change customer care.");
  const ctx: TenantServiceContext = { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase };
  // The company must be this org's (checked on the caller's own RLS client) before any service-role call.
  await assertCompanyInOrganization(ctx, context.params.companyId);
  return { organizationId: organization.organizationId, companyId: context.params.companyId, manager };
}

/** Settings → AI front desk → Customer care & warranty. Members read; the open cases only for owners/admins. */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const { organizationId, companyId, manager } = await guard(context, false);
    const data = await getCustomerCareView(createSupabaseAdminClient(), { organizationId, companyId }, { manager });
    if (!data) throw new UserFacingError("Company not found.", { status: 404 });
    return NextResponse.json({ data });
  });
}

/** Owner/admin: merge ONLY ai_settings.customer_care. */
export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const { organizationId, companyId } = await guard(context, true);
    const patch = await parseJsonBody(request, patchSchema);
    const data = await updateCustomerCareSettings(createSupabaseAdminClient(), { organizationId, companyId }, patch);
    if (!data) throw new UserFacingError("Company not found.", { status: 404 });
    return NextResponse.json({ data });
  });
}

/** Owner/admin: per-service warranty terms, installed equipment, resolving a case. */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const { organizationId, companyId } = await guard(context, true);
    const body = await parseJsonBody(request, actionSchema);
    const admin = createSupabaseAdminClient();
    const scope = { organizationId, companyId };
    if (body.action === "save_term") {
      const result = await saveWarrantyTerm(admin, scope, { catalogItemId: body.catalogItemId, months: body.months, terms: body.terms ?? null });
      if ("error" in result) throw new UserFacingError(result.error, { status: 400 });
    } else if (body.action === "save_equipment") {
      const result = await saveEquipment(admin, scope, body.equipment as EquipmentInput);
      if ("error" in result) throw new UserFacingError(result.error, { status: 400 });
    } else if (body.action === "remove_equipment") {
      if (!(await removeEquipment(admin, scope, body.equipmentId))) throw new UserFacingError("Equipment not found.", { status: 404 });
    } else {
      if (!(await resolveCaseById(admin, scope, body.caseId, body.outcome, Date.now()))) throw new UserFacingError("That case isn't open.", { status: 404 });
    }
    const data = await getCustomerCareView(admin, scope, { manager: true });
    if (!data) throw new UserFacingError("Company not found.", { status: 404 });
    return NextResponse.json({ data });
  });
}
