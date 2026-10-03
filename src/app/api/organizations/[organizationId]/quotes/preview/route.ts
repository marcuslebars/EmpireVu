import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { ValidationError, requireOrganizationContext } from "@/server/organizations/context";
import { CatalogError } from "@/server/services/quotes/catalog";
import { CatalogNotConfiguredError } from "@/server/services/quotes/catalog-repo";
import { getQuotesConfig } from "@/server/services/quotes/config";
import { priceQuoteForCompany } from "@/server/services/quotes/pricing";
import { assertCompanyInOrganization } from "@/server/services/shared";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string };
}

/** Same shape the create/update routes accept, so a preview prices exactly what will be saved. */
const previewSchema = z
  .object({
    companyId: z.string().uuid(),
    services: z
      .array(
        z.object({
          serviceId: z.string().min(1).max(80),
          lengthFt: z.number().positive().max(100).optional(),
          engineType: z.enum(["outboard", "sterndrive", "inboard"]).optional(),
          engineCount: z.number().int().min(1).max(8).optional(),
          quantity: z.number().int().min(1).max(24).optional(),
          distanceKm: z.number().positive().max(2000).optional(),
          optional: z.boolean().optional(),
          selected: z.boolean().optional(),
          modifiers: z.record(z.string().max(40), z.string().max(40)).optional(),
        }),
      )
      .max(20)
      .default([]),
    customLines: z
      .array(
        z.object({
          label: z.string().min(1).max(200),
          description: z.string().max(2000).optional(),
          amountCents: z.number().int().min(0).max(100_000_00),
          optional: z.boolean().optional(),
          selected: z.boolean().optional(),
        }),
      )
      .max(20)
      .default([]),
    hullType: z.string().max(40).optional(),
    bundleId: z.string().max(40).optional(),
  })
  .refine((v) => v.services.length + v.customLines.length > 0, { message: "Add at least one line.", path: ["services"] });

/** Price a quote without saving it — live totals while a quote is being built. */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    if (!getQuotesConfig().enabled) return NextResponse.json({ error: "Quotes are not enabled." }, { status: 404 });

    const supabase = createSupabaseServerClient();
    const org = await requireOrganizationContext(supabase, context.params.organizationId);
    const input = await parseJsonBody(request, previewSchema);
    await assertCompanyInOrganization({ organizationId: org.organizationId, actorProfileId: org.user.id, supabase }, input.companyId);

    try {
      const pricing = await priceQuoteForCompany(input.companyId, {
        services: input.services.map((s) => ({
          serviceId: s.serviceId,
          lengthFt: s.lengthFt,
          engineType: s.engineType,
          engineCount: s.engineCount,
          quantity: s.quantity,
          distanceKm: s.distanceKm,
          optional: s.optional,
          selected: s.selected,
          modifiers: s.modifiers,
        })),
        customLines: input.customLines.map((l) => ({
          label: l.label,
          description: l.description,
          amountCents: l.amountCents,
          optional: l.optional,
          selected: l.selected,
        })),
        hullType: input.hullType,
        bundleId: input.bundleId,
      });
      return NextResponse.json({ data: pricing });
    } catch (error) {
      // A bad selection (missing length, unknown service, needs review) is the user's to fix.
      if (error instanceof CatalogError || error instanceof CatalogNotConfiguredError) {
        throw new ValidationError(error.message);
      }
      throw error;
    }
  });
}
