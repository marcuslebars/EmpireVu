import { NextResponse } from "next/server";
import { z } from "zod";

import type { Json } from "@/server/db/database.types";
import { handleRoute, parseJsonBody } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { listCompanies } from "@/server/services/companies";
import {
  getOnboardingProgress,
  isOnboardingStep,
  nextOnboardingStep,
  recordOnboardingEvent,
  upsertOnboardingStep,
  type OnboardingEventType,
} from "@/server/services/onboarding";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string };
}

/** Resume state: the onboarding company (first one) + per-step progress rows. */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const ctx = { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase };

    const companies = await listCompanies(ctx, { limit: 1 });
    const company = companies[0] ?? null;
    const steps = company ? await getOnboardingProgress(ctx, company.id) : [];
    const completed = steps.filter((s) => s.status === "complete").map((s) => s.step);

    return NextResponse.json({
      data: {
        company: company ? { id: company.id, name: company.name } : null,
        steps,
        nextStep: nextOnboardingStep(completed),
      },
    });
  });
}

const upsertBodySchema = z.object({
  companyId: z.string().uuid(),
  step: z.string().min(1).max(40),
  status: z.enum(["pending", "in_progress", "complete", "error"]).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  completed: z.boolean().optional(),
  event: z.enum(["start", "complete", "error"]).optional(),
});

/** Upsert a step's progress and optionally log an instrumentation event. */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const ctx = { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase };
    const body = await parseJsonBody(request, upsertBodySchema);

    if (!isOnboardingStep(body.step)) {
      return NextResponse.json({ error: `Unknown onboarding step: ${body.step}` }, { status: 400 });
    }

    if (body.event) {
      await recordOnboardingEvent(ctx, {
        companyId: body.companyId,
        step: body.step,
        event: body.event as OnboardingEventType,
      });
    }

    const row = await upsertOnboardingStep(ctx, body.companyId, body.step, {
      status: body.status,
      data: body.data as Json | undefined,
      completed: body.completed,
    });

    return NextResponse.json({ data: row });
  });
}
