import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { UserFacingError } from "@/server/errors";
import { AuthorizationError, requireOrganizationContext } from "@/server/organizations/context";
import { assertCompanyInOrganization, type TenantServiceContext } from "@/server/services/shared";
import { removeSupplier, saveRecipe, saveSupplier, type RecipeLineInput } from "@/server/services/staff/purchasing/tracking";
import { getPurchasingView, updatePurchasingSettings } from "@/server/services/staff/purchasing/view";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; companyId: string };
}

const patchSchema = z
  .object({
    enabled: z.boolean().optional(),
    leadDays: z.number().int().min(1).max(14).optional(),
    maxPerDay: z.number().int().min(1).max(20).optional(),
    defaultFulfilment: z.enum(["pickup", "delivery"]).optional(),
    aiEstimate: z.boolean().optional(),
  })
  .strict();

const supplierSchema = z
  .object({
    id: z.string().uuid().nullable().optional(),
    name: z.string().max(80).nullable().optional(),
    branch: z.string().max(80).nullable().optional(),
    email: z.string().max(254).nullable().optional(),
    phone: z.string().max(30).nullable().optional(),
    accountNumber: z.string().max(60).nullable().optional(),
    preferred: z.boolean().optional(),
    notes: z.string().max(500).nullable().optional(),
  })
  .strict();

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save_supplier"), supplier: supplierSchema }).strict(),
  z.object({ action: z.literal("remove_supplier"), supplierId: z.string().uuid() }).strict(),
  z
    .object({
      action: z.literal("save_recipe"),
      catalogItemId: z.string().uuid(),
      lines: z
        .array(
          z
            .object({
              label: z.string().min(1).max(80),
              qtyPerUnit: z.number().positive().max(10_000),
              unit: z.string().max(20).nullable().optional(),
              estUnitCostCents: z.number().int().min(0).max(5_000_000).nullable().optional(),
              supplierId: z.string().uuid().nullable().optional(),
            })
            .strict(),
        )
        .max(30),
    })
    .strict(),
]);

async function guard(context: RouteContext, manage: boolean): Promise<{ organizationId: string; companyId: string; manager: boolean }> {
  const supabase = createSupabaseServerClient();
  const organization = await requireOrganizationContext(supabase, context.params.organizationId);
  const role = organization.membership.role;
  const manager = role === "owner" || role === "admin";
  if (manage && !manager) throw new AuthorizationError("Only owners and admins can change purchasing.");
  const ctx: TenantServiceContext = { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase };
  // The company must be this org's (checked on the caller's own RLS client) before any service-role call.
  await assertCompanyInOrganization(ctx, context.params.companyId);
  return { organizationId: organization.organizationId, companyId: context.params.companyId, manager };
}

/** Settings → AI front desk → Purchasing. Members read; suppliers (account numbers) only for owners/admins. */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const { organizationId, companyId, manager } = await guard(context, false);
    const data = await getPurchasingView(createSupabaseAdminClient(), { organizationId, companyId }, { manager });
    if (!data) throw new UserFacingError("Company not found.", { status: 404 });
    return NextResponse.json({ data });
  });
}

/** Owner/admin: merge ONLY ai_settings.purchasing. */
export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const { organizationId, companyId } = await guard(context, true);
    const patch = await parseJsonBody(request, patchSchema);
    const data = await updatePurchasingSettings(createSupabaseAdminClient(), { organizationId, companyId }, patch);
    if (!data) throw new UserFacingError("Company not found.", { status: 404 });
    return NextResponse.json({ data });
  });
}

/** Owner/admin: suppliers and recipes. */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const { organizationId, companyId } = await guard(context, true);
    const body = await parseJsonBody(request, actionSchema);
    const admin = createSupabaseAdminClient();
    const scope = { organizationId, companyId };
    const nowMs = Date.now();
    if (body.action === "save_supplier") {
      const s = body.supplier;
      const result = await saveSupplier(admin, scope, { ...s, branch: s.branch === undefined ? undefined : s.branch ?? null }, nowMs);
      if ("error" in result) throw new UserFacingError(result.error, { status: 400 });
    } else if (body.action === "remove_supplier") {
      if (!(await removeSupplier(admin, scope, body.supplierId, nowMs))) throw new UserFacingError("Supplier not found.", { status: 404 });
    } else {
      const result = await saveRecipe(admin, scope, body.catalogItemId, body.lines as RecipeLineInput[], nowMs);
      if ("error" in result) throw new UserFacingError(result.error, { status: 400 });
    }
    const data = await getPurchasingView(admin, scope, { manager: true });
    if (!data) throw new UserFacingError("Company not found.", { status: 404 });
    return NextResponse.json({ data });
  });
}
