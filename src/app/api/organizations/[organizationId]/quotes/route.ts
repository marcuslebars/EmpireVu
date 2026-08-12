import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { getQuotesConfig } from "@/server/services/quotes/config";
import { createQuote, listQuotes } from "@/server/services/quotes/service";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string };
}

const serviceSchema = z.object({
  serviceId: z.string().min(1).max(80),
  lengthFt: z.number().positive().max(100).optional(),
  engineType: z.enum(["outboard", "sterndrive", "inboard"]).optional(),
  engineCount: z.number().int().min(1).max(8).optional(),
});

const createSchema = z.object({
  contactId: z.string().uuid().optional(),
  companyId: z.string().uuid().optional(),
  services: z.array(serviceSchema).min(1).max(20),
  hullType: z.string().max(40).optional(),
  bundleId: z.string().max(40).optional(),
  notes: z.string().max(5000).optional(),
  source: z.string().max(80).optional(),
});

/** The whole feature is inert unless STRIPE_QUOTES_ENABLED=1 — a 404 hides it until then. */
function disabledResponse(): NextResponse | null {
  return getQuotesConfig().enabled ? null : NextResponse.json({ error: "Quotes are not enabled." }, { status: 404 });
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const off = disabledResponse();
    if (off) return off;

    const supabase = createSupabaseServerClient();
    const org = await requireOrganizationContext(supabase, context.params.organizationId);
    const parsed = createSchema.parse(await request.json().catch(() => ({})));

    const quote = await createQuote(
      { organizationId: org.organizationId, actorProfileId: org.user.id, supabase },
      {
        contactId: parsed.contactId,
        companyId: parsed.companyId,
        // Rebuild the services as fresh literals (every key present) so the shape lands
        // cleanly on QuoteServiceInput — zod's inferred keys read as optional under this
        // project's non-strict tsconfig.
        services: parsed.services.map((s) => ({
          serviceId: s.serviceId,
          lengthFt: s.lengthFt,
          engineType: s.engineType,
          engineCount: s.engineCount,
        })),
        hullType: parsed.hullType,
        bundleId: parsed.bundleId,
        notes: parsed.notes,
        source: parsed.source,
      },
    );
    return NextResponse.json({ data: quote }, { status: 201 });
  });
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const off = disabledResponse();
    if (off) return off;

    const supabase = createSupabaseServerClient();
    const org = await requireOrganizationContext(supabase, context.params.organizationId);
    const url = new URL(request.url);
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);

    const quotes = await listQuotes(
      { organizationId: org.organizationId, actorProfileId: org.user.id, supabase },
      { limit: Number.isFinite(limit) ? limit : 50 },
    );
    return NextResponse.json({ data: quotes });
  });
}
