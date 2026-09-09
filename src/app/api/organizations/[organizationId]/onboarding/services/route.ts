import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { createCatalogItem, listCatalogItems, PRICING_TYPES } from "@/server/services/quotes/catalog-items";
import { recordOnboardingEvent, upsertOnboardingStep } from "@/server/services/onboarding";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string };
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const ctx = { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase };
    const companyId = new URL(request.url).searchParams.get("companyId");
    if (!companyId) return NextResponse.json({ error: "companyId is required." }, { status: 400 });
    const items = await listCatalogItems(ctx, companyId);
    return NextResponse.json({ data: items });
  });
}

const confirmBodySchema = z.object({
  companyId: z.string().uuid(),
  items: z
    .array(
      z.object({
        label: z.string().min(1).max(200),
        description: z.string().max(2000).nullable().optional(),
        pricingType: z.enum(PRICING_TYPES).default("flat"),
        rateCents: z.number().int().nonnegative().max(100_000_000).default(0),
        minimumCents: z.number().int().nonnegative().max(100_000_000).default(0),
        unitLabel: z.string().max(60).nullable().optional(),
      }),
    )
    .min(1)
    .max(40),
});

/** Confirm + insert the edited catalog drafts, then mark the Services step complete. */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const ctx = { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase };
    const body = await parseJsonBody(request, confirmBodySchema);

    await recordOnboardingEvent(ctx, { companyId: body.companyId, step: "services", event: "start" });
    try {
      const created = [];
      for (const item of body.items) {
        created.push(await createCatalogItem(ctx, { companyId: body.companyId, ...item }));
      }
      await upsertOnboardingStep(ctx, body.companyId, "services", { completed: true, data: { count: created.length } });
      await recordOnboardingEvent(ctx, { companyId: body.companyId, step: "services", event: "complete" });
      return NextResponse.json({ data: { created: created.length } }, { status: 201 });
    } catch (err) {
      await recordOnboardingEvent(ctx, {
        companyId: body.companyId,
        step: "services",
        event: "error",
        metadata: { message: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    }
  });
}
