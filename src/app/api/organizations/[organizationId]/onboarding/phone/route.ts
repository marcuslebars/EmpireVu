import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { AuthorizationError, requireOrganizationContext } from "@/server/organizations/context";
import { orgCan } from "@/server/services/billing/gating";
import { isCatcherOnlyTier } from "@/lib/phone-modes";
import { getOnboardingProgress, recordOnboardingEvent, upsertOnboardingStep } from "@/server/services/onboarding";
import { provisionPhoneForCompany } from "@/server/services/onboarding-provision";
import { createRetellClient, getRetellApiKey } from "@/server/services/retell/provision";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

/** A CrankLeads Catch/Close org without a marina_reception override. */
async function isCatcherOnlyCrankleadsOrg(
  supabase: ReturnType<typeof createSupabaseServerClient>,
  organizationId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("organizations")
    .select("crankleads_tier")
    .eq("id", organizationId)
    .maybeSingle();
  if (error) throw error;
  const tier = (data as { crankleads_tier: string | null } | null)?.crankleads_tier ?? null;
  if (!isCatcherOnlyTier(tier)) return false;
  return !(await orgCan(supabase, organizationId, "marina_reception"));
}

interface RouteContext {
  params: { organizationId: string };
}

/** List the account's existing Retell numbers (for "attach an existing number"). */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    await requireOrganizationContext(supabase, context.params.organizationId);
    const apiKey = getRetellApiKey();
    if (!apiKey) return NextResponse.json({ data: { configured: false, numbers: [] } });
    const numbers = await createRetellClient(apiKey).listPhoneNumbers();
    return NextResponse.json({
      data: {
        configured: true,
        numbers: (numbers ?? []).map((n) => ({ phoneNumber: n.phone_number, pretty: n.phone_number_pretty ?? null })),
      },
    });
  });
}

const provisionBodySchema = z.object({
  companyId: z.string().uuid(),
  areaCode: z.number().int().min(200).max(999).optional(),
  attachNumber: z.string().max(40).optional(),
});

/** Provision (or re-provision) Marina + a number for the company. Idempotent. */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const ctx = { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase };
    const body = await parseJsonBody(request, provisionBodySchema);

    // CrankLeads Catch / Close bought the missed-call catcher, not the AI receptionist
    // (that's Front Desk). Only those orgs are gated here — every other org (self-serve
    // trials, existing operate/launch orgs, house orgs) behaves exactly as before. A
    // feature_flags override of marina_reception still lets the operator switch it on.
    if (await isCatcherOnlyCrankleadsOrg(supabase, organization.organizationId)) {
      throw new AuthorizationError(
        "The AI receptionist isn't included in your plan. Use the missed-call catcher, or upgrade to Front Desk.",
      );
    }

    await recordOnboardingEvent(ctx, { companyId: body.companyId, step: "phone", event: "start" });
    try {
      // Prior ids (if this step ran before) → update instead of create.
      const progress = await getOnboardingProgress(ctx, body.companyId);
      const prior = progress.find((p) => p.step === "phone")?.data as
        | { llmId?: string; agentId?: string; phoneNumber?: string }
        | undefined;

      const result = await provisionPhoneForCompany(ctx, {
        companyId: body.companyId,
        areaCode: body.areaCode ?? null,
        attachNumber: body.attachNumber ?? null,
        existing: prior ? { llmId: prior.llmId, agentId: prior.agentId, phoneNumber: prior.phoneNumber } : undefined,
      });

      await upsertOnboardingStep(ctx, body.companyId, "phone", {
        completed: true,
        data: { llmId: result.llmId, agentId: result.agentId, phoneNumber: result.phoneNumber },
      });
      await recordOnboardingEvent(ctx, { companyId: body.companyId, step: "phone", event: "complete" });

      return NextResponse.json({
        data: { phoneNumber: result.phoneNumber, phoneNumberPretty: result.phoneNumberPretty, purchased: result.purchasedNumber },
      });
    } catch (err) {
      await recordOnboardingEvent(ctx, {
        companyId: body.companyId,
        step: "phone",
        event: "error",
        metadata: { message: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    }
  });
}
