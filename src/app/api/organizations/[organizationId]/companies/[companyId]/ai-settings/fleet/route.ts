import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { UserFacingError } from "@/server/errors";
import { AuthorizationError, requireOrganizationContext } from "@/server/organizations/context";
import { assertCompanyInOrganization, type TenantServiceContext } from "@/server/services/shared";
import { getFleetView, runFleetAction, updateFleetSettings, type FleetAction } from "@/server/services/staff/fleet/view";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; companyId: string };
}

const patchSchema = z.object({ enabled: z.boolean().optional(), reminders: z.boolean().optional() }).strict();

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const uuid = z.string().uuid();

const vehicleSchema = z
  .object({
    id: uuid.nullable().optional(),
    name: z.string().max(60).optional(),
    year: z.number().int().min(1950).max(2100).nullable().optional(),
    make: z.string().max(40).nullable().optional(),
    model: z.string().max(60).nullable().optional(),
    plate: z.string().max(12).nullable().optional(),
    vin: z.string().max(25).nullable().optional(),
    profileId: uuid.nullable().optional(),
    plateStickerDue: date.nullable().optional(),
    safetyInspectionRequired: z.boolean().optional(),
    safetyInspectionDue: date.nullable().optional(),
    odometerKm: z.number().int().min(0).max(3_000_000).nullable().optional(),
    notes: z.string().max(500).nullable().optional(),
    active: z.boolean().optional(),
  })
  .strict();

const serviceItemSchema = z
  .object({
    id: uuid.nullable().optional(),
    label: z.string().max(60).optional(),
    everyKm: z.number().int().min(100).max(200_000).nullable().optional(),
    everyMonths: z.number().int().min(1).max(60).nullable().optional(),
    lastDoneKm: z.number().int().min(0).max(3_000_000).nullable().optional(),
    lastDoneOn: date.nullable().optional(),
    active: z.boolean().optional(),
  })
  .strict();

const equipmentSchema = z
  .object({
    id: uuid.nullable().optional(),
    name: z.string().max(60).optional(),
    serial: z.string().max(60).nullable().optional(),
    valueCents: z.number().int().min(0).max(10_000_000_000).nullable().optional(),
    status: z.enum(["available", "out", "in_shop", "retired"]).optional(),
    location: z.string().max(120).nullable().optional(),
    serviceEveryHours: z.number().positive().max(100_000).nullable().optional(),
    serviceEveryMonths: z.number().int().min(1).max(60).nullable().optional(),
    lastServicedOn: date.nullable().optional(),
    lastServicedHours: z.number().min(0).max(1_000_000).nullable().optional(),
    hours: z.number().min(0).max(1_000_000).nullable().optional(),
    notes: z.string().max(500).nullable().optional(),
  })
  .strict();

const rentalSchema = z
  .object({
    id: uuid.nullable().optional(),
    item: z.string().max(80).optional(),
    vendor: z.string().max(80).nullable().optional(),
    vendorPhone: z.string().max(30).nullable().optional(),
    dueBackLocal: z.string().max(16).nullable().optional(),
    rateCentsPerDay: z.number().int().min(0).max(10_000_000).nullable().optional(),
    notes: z.string().max(500).nullable().optional(),
  })
  .strict();

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save_vehicle"), vehicle: vehicleSchema }).strict(),
  z.object({ action: z.literal("save_service_item"), vehicleId: uuid, item: serviceItemSchema }).strict(),
  z
    .object({
      action: z.literal("service_done"),
      vehicleId: uuid.optional(),
      equipmentId: uuid.optional(),
      label: z.string().min(1).max(60),
      km: z.number().int().min(0).max(3_000_000).nullable().optional(),
      hours: z.number().min(0).max(1_000_000).nullable().optional(),
      date: date.nullable().optional(),
    })
    .strict(),
  z.object({ action: z.literal("save_equipment"), equipment: equipmentSchema }).strict(),
  z.object({ action: z.literal("equipment_status"), equipmentId: uuid, status: z.enum(["out", "available", "in_shop"]), location: z.string().max(120).nullable().optional() }).strict(),
  z.object({ action: z.literal("save_rental"), rental: rentalSchema }).strict(),
  z.object({ action: z.literal("return_rental"), rentalId: uuid }).strict(),
]);

async function guard(context: RouteContext, manage: boolean): Promise<{ organizationId: string; companyId: string }> {
  const supabase = createSupabaseServerClient();
  const organization = await requireOrganizationContext(supabase, context.params.organizationId);
  const role = organization.membership.role;
  if (manage && role !== "owner" && role !== "admin") throw new AuthorizationError("Only owners and admins can change fleet & equipment.");
  const ctx: TenantServiceContext = { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase };
  // The company must be this org's (checked on the caller's own RLS client) before any service-role call.
  await assertCompanyInOrganization(ctx, context.params.companyId);
  return { organizationId: organization.organizationId, companyId: context.params.companyId };
}

/** Settings → AI front desk → Fleet & equipment. Members read. */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const scope = await guard(context, false);
    const data = await getFleetView(createSupabaseAdminClient(), scope);
    if (!data) throw new UserFacingError("Company not found.", { status: 404 });
    return NextResponse.json({ data });
  });
}

/** Owner/admin: merge ONLY ai_settings.fleet. */
export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const scope = await guard(context, true);
    const patch = await parseJsonBody(request, patchSchema);
    const data = await updateFleetSettings(createSupabaseAdminClient(), scope, patch);
    if (!data) throw new UserFacingError("Company not found.", { status: 404 });
    return NextResponse.json({ data });
  });
}

/** Owner/admin: vehicles, service schedules, equipment, rentals. */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const scope = await guard(context, true);
    const body = (await parseJsonBody(request, actionSchema)) as FleetAction;
    const admin = createSupabaseAdminClient();
    const result = await runFleetAction(admin, scope, body);
    if (!result) throw new UserFacingError("Company not found.", { status: 404 });
    if ("error" in result) throw new UserFacingError(result.error, { status: 400 });
    const data = await getFleetView(admin, scope);
    if (!data) throw new UserFacingError("Company not found.", { status: 404 });
    return NextResponse.json({ data });
  });
}
