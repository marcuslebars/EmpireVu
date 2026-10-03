import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { getQuotesConfig, quotePublicBaseUrlFor } from "@/server/services/quotes/config";
import { createQuote, listQuotes, REVIEWABLE_STATUSES } from "@/server/services/quotes/service";
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
  // per_unit services (batteries, PWCs, transport trips, vessel-months).
  quantity: z.number().int().min(1).max(24).optional(),
  // per_km services (transport beyond the extended band).
  distanceKm: z.number().positive().max(2000).optional(),
  // Customer-toggleable on the hosted page; off unless explicitly selected.
  optional: z.boolean().optional(),
  selected: z.boolean().optional(),
  // Modifier choices (tier, boat type…) keyed by group.
  modifiers: z.record(z.string().max(40), z.string().max(40)).optional(),
});

/** Hand-priced Care lines. amountCents is trusted from an authenticated org member. */
const customLineSchema = z.object({
  label: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  amountCents: z.number().int().min(0).max(100_000_00),
  optional: z.boolean().optional(),
  selected: z.boolean().optional(),
});

const createSchema = z.object({
  contactId: z.string().uuid().optional(),
  companyId: z.string().uuid().optional(),
  // A Care-only quote has no engine services at all, so the floor is 0 — the
  // refinement below keeps a wholly empty quote out.
  services: z.array(serviceSchema).max(20).default([]),
  customLines: z.array(customLineSchema).max(20).default([]),
  hullType: z.string().max(40).optional(),
  bundleId: z.string().max(40).optional(),
  title: z.string().max(200).optional(),
  introMessage: z.string().max(5000).optional(),
  notes: z.string().max(5000).optional(),
  source: z.string().max(80).optional(),
}).refine((v) => v.services.length + v.customLines.length > 0, {
  message: "A quote needs at least one service or custom line.",
  path: ["services"],
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

    // ?review=1 is the auto-quote review window: machine-written quotes that are
    // out with a customer and not yet paid. It is the only window where a wrong
    // price can still be voided and reissued for free.
    const review = url.searchParams.get("review") === "1";
    const autoParam = url.searchParams.get("auto");

    const quotes = await listQuotes(
      { organizationId: org.organizationId, actorProfileId: org.user.id, supabase },
      {
        limit: Number.isFinite(limit) ? limit : 50,
        autoGenerated: review ? true : autoParam === "1" ? true : autoParam === "0" ? false : undefined,
        statuses: review ? REVIEWABLE_STATUSES : undefined,
      },
    );
    // Who each quote is for, and whether it's been invoiced — the list shows both.
    const ctx = { organizationId: org.organizationId, actorProfileId: org.user.id, supabase };
    const contactIds = [...new Set(quotes.map((q) => q.contact_id).filter((v): v is string => Boolean(v)))];
    const quoteIds = quotes.map((q) => q.id);
    const [{ data: contacts }, { data: invoices }] = await Promise.all([
      contactIds.length
        ? ctx.supabase.from("contacts").select("id, first_name, last_name, email, phone").eq("organization_id", ctx.organizationId).in("id", contactIds)
        : Promise.resolve({ data: [] as Array<{ id: string; first_name: string; last_name: string | null; email: string | null; phone: string | null }> }),
      quoteIds.length
        ? ctx.supabase.from("invoices").select("id, quote_id, status").eq("organization_id", ctx.organizationId).in("quote_id", quoteIds).neq("status", "void")
        : Promise.resolve({ data: [] as Array<{ id: string; quote_id: string | null; status: string }> }),
    ]);
    const companyIds = [...new Set(quotes.map((q) => q.company_id).filter((v): v is string => Boolean(v)))];
    const { data: companies } = companyIds.length
      ? await ctx.supabase.from("companies").select("id, quote_public_base_url").eq("organization_id", ctx.organizationId).in("id", companyIds)
      : { data: [] as Array<{ id: string; quote_public_base_url: string | null }> };
    const originByCompany = new Map((companies ?? []).map((c) => [c.id, quotePublicBaseUrlFor(c)]));
    const byContact = new Map((contacts ?? []).map((c) => [c.id, c]));
    const byQuote = new Map((invoices ?? []).map((i) => [i.quote_id, i]));
    const data = quotes.map((q) => {
      const c = q.contact_id ? byContact.get(q.contact_id) : undefined;
      const name = c ? [c.first_name, c.last_name].filter((p) => p && p !== "Lead").join(" ").trim() || c.email || c.phone : null;
      const inv = byQuote.get(q.id);
      const origin = (q.company_id && originByCompany.get(q.company_id)) || quotePublicBaseUrlFor(null);
      return { ...q, public_url: `${origin}/q/${q.public_token}`, contact_name: name ?? null, contact_email: c?.email ?? null, invoice_id: inv?.id ?? null, invoice_status: inv?.status ?? null };
    });
    return NextResponse.json({ data });
  });
}
