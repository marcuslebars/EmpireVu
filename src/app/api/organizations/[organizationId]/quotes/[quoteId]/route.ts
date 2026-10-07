import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { getQuotesConfig, quotePublicBaseUrlFor } from "@/server/services/quotes/config";
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
  // Modifier choices (tier, boat type…) keyed by group.
  modifiers: z.record(z.string().max(40), z.string().max(40)).optional(),
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
    /** Set after the owner confirmed a total change on a quote the customer already has. */
    confirmTotalChange: z.boolean().optional(),
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
    // The customer's link, on the brand's own quote domain.
    const { data: company } = quote.company_id
      ? await supabase.from("companies").select("quote_public_base_url").eq("organization_id", org.organizationId).eq("id", quote.company_id).maybeSingle()
      : { data: null };
    return NextResponse.json({ data: { ...quote, public_url: `${quotePublicBaseUrlFor(company)}/q/${quote.public_token}` } });
  });
}

/**
 * Re-price and edit. Refused once the quote is approved — see updateQuote.
 *
 * On a sent / viewed quote, an edit that would change the total the customer sees
 * is NOT saved unless `confirmTotalChange: true` is sent: the answer is
 * 409 { code: "total_changed", oldTotalCents, newTotalCents } so the app can ask.
 */
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
          modifiers: s.modifiers,
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
        confirmTotalChange: parsed.confirmTotalChange,
      },
    );
    return NextResponse.json({ data: quote });
  });
}
