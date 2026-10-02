import { NextResponse } from "next/server";
import { z } from "zod";

import type { Json } from "@/server/db/database.types";
import { handleRoute, parseJsonBody } from "@/server/api/route";
import { AuthorizationError, requireOrganizationContext, ValidationError } from "@/server/organizations/context";
import { getOnboardingProgress, recordOnboardingEvent, upsertOnboardingStep } from "@/server/services/onboarding";
import { getMissedCallCatcherStatus, provisionMissedCallCatcher } from "@/server/services/twilio/provision";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string };
}

/** The company's missed-call catcher number + carrier forwarding instructions. Members. */
export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const companyId = new URL(request.url).searchParams.get("companyId");
    if (!companyId || !z.string().uuid().safeParse(companyId).success) {
      throw new ValidationError("companyId is required.");
    }
    const data = await getMissedCallCatcherStatus(
      { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase },
      companyId,
    );
    return NextResponse.json({ data });
  });
}

const provisionBodySchema = z.object({
  companyId: z.string().uuid(),
  areaCode: z.number().int().min(200).max(999).optional(),
  attachNumber: z.string().max(40).optional(),
});

/**
 * Buy (by area code) or attach a Twilio number as the company's missed-call catcher and
 * configure its voice + SMS webhooks. Idempotent. Admin-only (it buys a number). Also
 * records the wizard's Phone step (mode='missed_call_catcher'), merged into any prior data.
 */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    if (!["owner", "admin"].includes(organization.membership.role)) {
      throw new AuthorizationError("Admin access is required to set up the missed-call catcher.");
    }
    const ctx = { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase };
    const body = await parseJsonBody(request, provisionBodySchema);

    await recordOnboardingEvent(ctx, {
      companyId: body.companyId,
      step: "phone",
      event: "start",
      metadata: { mode: "missed_call_catcher" },
    });
    try {
      const result = await provisionMissedCallCatcher(ctx, {
        companyId: body.companyId,
        areaCode: body.areaCode ?? null,
        attachNumber: body.attachNumber ?? null,
      });

      const progress = await getOnboardingProgress(ctx, body.companyId);
      const prior = progress.find((p) => p.step === "phone")?.data;
      const priorData = prior && typeof prior === "object" && !Array.isArray(prior) ? prior : {};
      const data: Json = {
        ...priorData,
        mode: "missed_call_catcher",
        phoneNumber: result.phoneNumber,
        catcherNumber: result.phoneNumber,
        catcherNumberSid: result.numberSid,
      };
      await upsertOnboardingStep(ctx, body.companyId, "phone", { completed: true, data });
      await recordOnboardingEvent(ctx, {
        companyId: body.companyId,
        step: "phone",
        event: "complete",
        metadata: { mode: "missed_call_catcher" },
      });

      return NextResponse.json({ data: result });
    } catch (err) {
      await recordOnboardingEvent(ctx, {
        companyId: body.companyId,
        step: "phone",
        event: "error",
        metadata: { mode: "missed_call_catcher", message: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    }
  });
}
