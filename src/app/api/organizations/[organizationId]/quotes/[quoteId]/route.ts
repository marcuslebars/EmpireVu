import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { getQuotesConfig } from "@/server/services/quotes/config";
import { getQuote, updateQuote } from "@/server/services/quotes/service";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; quoteId: string };
}

const serviceSchema = z.object({
  serviceId: z.string().min(1).max(80),
  lengthFt: z.number().positive().max(100).optional(),
  engineType: z.enum(["outboard", "sterndrive", "inboard"]).optional(),
  engineCount: z.number().int().min(1).max(8).optional(),
  quantity: z.number().int().min(1).max(24).optional(),
  distanceKm: z.number().positive().max(2000).optional(),
  optional: z.boolean().optional(),
  selected: z.boolean().optional(),
});

const customLineSchema = z.object({
  label: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  amountCents: z.number().int().min(0).max(100_000_00),
  optional: z.boolean().optional(),
  selected: z.boolean().optional(),
});

const updateSchema = z
  .object({
    contactId: z.string().uuid().optional(),
    companyId: z.string().uuid().optional(),
    services: z.array(serviceSchema).max(20).default([]),
    customLines: z.array(customLineSchema).max(20).default([]),
    hullType: z.string().max(40).optional(),
    bundleId: z.string().max(40).optional(),
    title: z.string().max(200).optional(),
    introMessage: z.string().max(5000).optional(),
    notes: z.string().max(5000).optional(),
  })
  .refine((v) => v.services.length + v.customLines.length > 0, {
    message: "A quote needs at least one service or custom line.",
    path: ["services"],
  });

function disabledResponse(): NextResponse | null {
  return getQuotesConfig().enabled ? null : NextResponse.json({ error: "Quotes are not enabled." }, { status: 404 });
}

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const off = disabledResponse();
    if (off) return off;

    const supabase = createSupabaseServerClient();
    const org = await requireOrganizationContext(supabase, context.params.organizationId);
    const quote = await getQuote(
      { organizationId: org.organizationId, actorProfileId: org.user.id, supabase },
      context.params.quoteId,
    );
    if (!quote) return NextResponse.json({ error: "Quote not found." }, { status: 404 });
    return NextResponse.json({ data: quote });
  });
}

/** Re-price and edit. Refused once the quote is approved — see updateQuote. */
export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const off = disabledResponse();
    if (off) return off;

    const supabase = createSupabaseServerClient();
    const org = await requireOrganizationContext(supabase, context.params.organizationId);
    const parsed = updateSchema.parse(await request.json().catch(() => ({})));

    const quote = await updateQuote(
      { organizationId: org.organizationId, actorProfileId: org.user.id, supabase },
      context.params.quoteId,
      {
        contactId: parsed.contactId,
        companyId: parsed.companyId,
        services: parsed.services.map((s) => ({
          serviceId: s.serviceId,
          lengthFt: s.lengthFt,
          engineType: s.engineType,
          engineCount: s.engineCount,
          quantity: s.quantity,
          distanceKm: s.distanceKm,
          optional: s.optional,
          selected: s.selected,
        })),
        customLines: parsed.customLines.map((l) => ({
          label: l.label,
          description: l.description,
          amountCents: l.amountCents,
          optional: l.optional,
          selected: l.selected,
        })),
        hullType: parsed.hullType,
        bundleId: parsed.bundleId,
        title: parsed.title,
        introMessage: parsed.introMessage,
        notes: parsed.notes,
      },
    );
    return NextResponse.json({ data: quote });
  });
}
