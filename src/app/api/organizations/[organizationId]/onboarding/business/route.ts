import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { createCompany, updateCompany } from "@/server/services/companies";
import { recordOnboardingEvent, upsertOnboardingStep } from "@/server/services/onboarding";
import { saveOwnerPhoneUnverified } from "@/server/services/owner-channel/owner-phone";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string };
}

const businessBodySchema = z.object({
  companyId: z.string().uuid().optional(),
  name: z.string().min(1).max(200),
  website: z.string().url().max(300).nullable().optional(),
  timezone: z.string().max(80).nullable().optional(),
  hours: z.record(z.string(), z.unknown()).nullable().optional(),
  serviceArea: z.string().max(500).nullable().optional(),
  ownerEmail: z.string().email().max(320).nullable().optional(),
  ownerPhone: z.string().max(40).nullable().optional(),
  brandLogoUrl: z.string().url().startsWith("https://").max(500).nullable().optional(),
  brandPrimaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable().optional(),
  brandAccentColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable().optional(),
});

/**
 * Business step: create the company on first run (idempotent — updates thereafter) and save
 * its profile + branding, then mark the step complete.
 */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const ctx = { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase };
    const body = await parseJsonBody(request, businessBodySchema);

    await recordOnboardingEvent(ctx, { companyId: body.companyId ?? null, step: "business", event: "start" });

    try {
      const companyId = body.companyId ?? (await createCompany(ctx, { name: body.name, website: body.website ?? null, stage: "active" })).id;

      const company = await updateCompany(ctx, companyId, {
        name: body.name,
        website: body.website,
        timezone: body.timezone,
        hours: body.hours,
        serviceArea: body.serviceArea,
        ownerEmail: body.ownerEmail,
        brandLogoUrl: body.brandLogoUrl,
        brandPrimaryColor: body.brandPrimaryColor,
        brandAccentColor: body.brandAccentColor,
      });

      // The owner's cell is the owner channel's identity: not client-writable. Owners/admins
      // save it here (service role, pinned to this org + company) UNVERIFIED; it's used for
      // owner texts only after the code sent from Settings → AI front desk is entered.
      if (body.ownerPhone !== undefined) {
        const role = organization.membership.role;
        if (role === "owner" || role === "admin") {
          await saveOwnerPhoneUnverified(createSupabaseAdminClient(), { organizationId: organization.organizationId, companyId, phone: body.ownerPhone?.trim() || null });
        }
      }

      await upsertOnboardingStep(ctx, companyId, "business", { completed: true, data: { name: company.name } });
      await recordOnboardingEvent(ctx, { companyId, step: "business", event: "complete" });

      return NextResponse.json({ data: { company: { id: company.id, name: company.name } } });
    } catch (err) {
      await recordOnboardingEvent(ctx, {
        companyId: body.companyId ?? null,
        step: "business",
        event: "error",
        metadata: { message: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    }
  });
}
